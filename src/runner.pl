#!/usr/bin/perl
# egg's runner: the one way a room thread starts a run that matters, so that
# egg knows the truth about it rather than the model's word.
#
#   .egg/bin/run <id> "<what it is for>" -- <command…>        start it detached; returns at once
#   .egg/bin/run --fg <id> "<what it is for>" -- <command…>   run it now and wait (short commands)
#   .egg/bin/run --list                                        every run and what its record says
#
# One argument after -- is a shell command line (run with /bin/sh -c); more
# than one is run as it is. The command runs in the current directory, its
# output goes to .egg/logs/<id>.log, and .egg/runs/<id>.json records the
# command, start time and process id, then its exit status and end time. A
# detached run is in a new session of its own, so it outlives the tool call
# and the turn that started it, and the record's time is touched every 15 s
# while it runs. It also appends a line to .egg/ledger.jsonl at the start and
# at the end. Ids are never reused.
#
# Put here by egg. Plain Perl 5 with core modules only: it ships with macOS
# and nearly every Linux.
use strict;
use warnings;
use POSIX ();
use File::Basename qw(dirname);
use Cwd qw(abs_path getcwd);
use Time::HiRes qw(time);

my $BEAT = 15;
my $here = dirname(abs_path($0));
my $root = dirname($here);    # .egg
my $runs = "$root/runs";
my $logs = "$root/logs";

sub usage {
  print STDERR "usage: .egg/bin/run [--fg] <id> \"<what it is for>\" -- <command…>\n       .egg/bin/run --list\n";
  exit 2;
}

sub jstr {
  my ($s) = @_;
  $s = "" unless defined $s;
  $s =~ s/\\/\\\\/g;
  $s =~ s/"/\\"/g;
  $s =~ s/\n/\\n/g;
  $s =~ s/\r/\\r/g;
  $s =~ s/\t/\\t/g;
  $s =~ s/([\x00-\x1f\x7f])/sprintf("\\u%04x", ord($1))/ge;
  return "\"$s\"";
}

sub iso {
  my ($t) = @_;
  my @g = gmtime(int($t));
  return sprintf("%04d-%02d-%02dT%02d:%02d:%02d.%03dZ", $g[5] + 1900, $g[4] + 1, $g[3], $g[2], $g[1], $g[0], int(($t - int($t)) * 1000));
}

sub json_obj {
  my (@pairs) = @_;
  my @out;
  while (@pairs) {
    my ($k, $v) = splice(@pairs, 0, 2);
    my $val = !defined($v) ? "null" : ref($v) eq "SCALAR" ? $$v : jstr($v);
    push @out, jstr($k) . ":" . $val;
  }
  return "{" . join(",", @out) . "}";
}
sub num { my ($n) = @_; return defined($n) ? \(0 + $n) : undef }
sub bool { my ($b) = @_; return \($b ? "true" : "false") }

sub write_atomic {
  my ($path, $text) = @_;
  my $tmp = "$path.tmp.$$";
  open(my $fh, ">", $tmp) or return 0;
  print $fh $text, "\n";
  close($fh);
  return rename($tmp, $path);
}

sub append_line {
  my ($path, $text) = @_;
  open(my $fh, ">>", $path) or return;
  print $fh $text, "\n";
  close($fh);
}

sub shell_quote {
  my ($s) = @_;
  return $s if $s =~ /^[A-Za-z0-9_\/.,:=+\@%-]+$/;
  $s =~ s/'/'\\''/g;
  return "'$s'";
}

if (@ARGV && $ARGV[0] eq "--list") {
  opendir(my $dh, $runs) or do { print "no runs yet\n"; exit 0 };
  for my $f (sort grep { /\.json$/ } readdir($dh)) {
    open(my $fh, "<", "$runs/$f") or next;
    local $/;
    my $j = <$fh>;
    close($fh);
    my ($id) = $j =~ /"id":"([^"]*)"/;
    my ($exit) = $j =~ /"exit":(-?\d+|null)/;
    my ($for) = $j =~ /"for":"((?:[^"\\]|\\.)*)"/;
    my ($pid) = $j =~ /"pid":(\d+)/;
    my $state = defined($exit) && $exit ne "null" ? "exit $exit" : ($pid && kill(0, $pid)) ? "running" : "no exit recorded, process gone";
    printf("%-8s %-28s %s\n", $id // $f, $state, $for // "");
  }
  exit 0;
}

my $fg = 0;
if (@ARGV && $ARGV[0] eq "--fg") { $fg = 1; shift @ARGV }
usage() if @ARGV < 4;
my $id = shift @ARGV;
my $for = shift @ARGV;
my $sep = shift @ARGV;
usage() unless $sep eq "--" && @ARGV >= 1;
if ($id !~ /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/) {
  print STDERR "run: the id must be letters, digits, '.', '_' or '-', at most 40 (got '$id')\n";
  exit 2;
}
my @cmd = @ARGV;
my $command = @cmd == 1 ? $cmd[0] : join(" ", map { shell_quote($_) } @cmd);
@cmd = ("/bin/sh", "-c", $cmd[0]) if @cmd == 1;

for my $d ($runs, $logs) {
  next if -d $d;
  mkdir($d) or do { print STDERR "run: cannot make $d: $!\n"; exit 2 };
}
my $record = "$runs/$id.json";
my $log = "$logs/$id.log";
if (-e $record) {
  print STDERR "run: $id is already used (see .egg/runs/$id.json); ids are never reused, pick a new one\n";
  exit 2;
}
my $cwd = getcwd();
my $ledger = "$root/ledger.jsonl";
my $relLog = ".egg/logs/$id.log";

# Claim the id at once, so two runs cannot take it.
write_atomic($record, json_obj(id => $id, for => $for, command => $command, cwd => $cwd, log => $relLog, pid => undef, pgid => undef, detached => bool(!$fg), startedAt => iso(time()), startedMs => num(int(time() * 1000)), exit => undef));

sub supervise {
  my ($detached) = @_;
  my $start = time();
  my $pgid = $detached ? POSIX::getpgrp() : undef;
  my $child = fork();
  if (!defined $child) {
    write_atomic($record, json_obj(id => $id, for => $for, command => $command, cwd => $cwd, log => $relLog, pid => num($$), pgid => num($pgid), detached => bool($detached), startedAt => iso($start), startedMs => num(int($start * 1000)), exit => num(127), signal => undef, endedAt => iso(time()), endedMs => num(int(time() * 1000)), error => "could not fork: $!"));
    return 127;
  }
  if ($child == 0) {
    open(STDIN, "<", "/dev/null");
    open(STDOUT, ">>", $log) or POSIX::_exit(127);
    open(STDERR, ">&", \*STDOUT);
    { no warnings "exec"; exec { $cmd[0] } @cmd; }
    print STDERR "run: could not start $cmd[0]: $!\n";
    POSIX::_exit(127);
  }
  my $head = sub {
    return (id => $id, for => $for, command => $command, cwd => $cwd, log => $relLog, pid => num($$), pgid => num($pgid), child => num($child), detached => bool($detached), startedAt => iso($start), startedMs => num(int($start * 1000)));
  };
  write_atomic($record, json_obj($head->(), exit => undef));
  append_line($ledger, json_obj(id => $id, at => iso($start), for => $for, command => $command, output => $relLog, exit => undef));
  my $term = 0;
  local $SIG{TERM} = sub { $term = 1; kill("TERM", $child) };
  local $SIG{INT} = sub { $term = 1; kill("INT", $child) };
  $SIG{HUP} = "IGNORE" if $detached;
  my $last = time();
  my $status;
  while (1) {
    my $w = waitpid($child, POSIX::WNOHANG());
    if ($w == $child) { $status = $?; last }
    if ($w == -1) { $status = 255 << 8; last }
    if (time() - $last >= $BEAT) {
      utime(undef, undef, $record);
      $last = time();
    }
    select(undef, undef, undef, time() - $start < 3 ? 0.05 : 0.5);
  }
  my $sig = $status & 127;
  my $exit = $sig ? 128 + $sig : $status >> 8;
  my $end = time();
  write_atomic($record, json_obj($head->(), exit => num($exit), signal => num($sig || undef), endedAt => iso($end), endedMs => num(int($end * 1000))));
  append_line($ledger, json_obj(id => $id, at => iso($end), exit => num($exit)));
  return $exit;
}

if ($fg) {
  my $exit = supervise(0);
  if (open(my $fh, "<", $log)) {
    my @lines = <$fh>;
    close($fh);
    my $from = @lines > 60 ? @lines - 60 : 0;
    print "(… ", $from, " earlier lines in $relLog)\n" if $from;
    print @lines[$from .. $#lines];
  }
  print "[$id exit $exit · log $relLog · record .egg/runs/$id.json]\n";
  exit($exit > 255 ? 255 : $exit);
}

# Detached: fork, new session, fork again; the grandchild supervises. The
# first process waits for word that it started, then returns.
pipe(my $r, my $w) or die "run: pipe: $!";
my $pid = fork();
die "run: fork: $!" unless defined $pid;
if ($pid == 0) {
  close($r);
  POSIX::setsid();
  my $p2 = fork();
  POSIX::_exit(0) if !defined($p2) || $p2 > 0;
  open(STDIN, "<", "/dev/null");
  open(STDOUT, ">>", "/dev/null");
  open(STDERR, ">>", "/dev/null");
  chdir($cwd);
  # Tell the first process this one's pid, then let go of it.
  my $old = select($w);
  $| = 1;
  select($old);
  print $w "$$\n";
  close($w);
  supervise(1);
  POSIX::_exit(0);
}
close($w);
waitpid($pid, 0);
my $sup = <$r>;
close($r);
chomp($sup) if defined $sup;
if (!$sup) {
  print STDERR "run: $id did not start\n";
  exit 1;
}
# Wait briefly for the record to name its process, so the caller can rely on it.
for (1 .. 20) {
  open(my $fh, "<", $record) or last;
  local $/;
  my $j = <$fh>;
  close($fh);
  last if $j =~ /"child":\d+/ || $j =~ /"exit":\d+/;
  select(undef, undef, undef, 0.05);
}
print "$id started (pid $sup) · log $relLog · record .egg/runs/$id.json\n";
exit 0;
