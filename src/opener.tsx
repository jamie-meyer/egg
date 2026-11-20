// Opening egg's page from anywhere in bb with one shortcut.
//
// A command's run() is given no way to navigate, and useBbNavigate() is a
// hook. So egg mounts one component that draws nothing on every screen of the
// app, and it keeps the navigate function where the command can reach it.
import { type BbNavigate, useBbNavigate } from "@get-bb/plugin-sdk/app";
import { type ComponentType, createElement, useEffect } from "react";

/** The navPanel's path, as registered in app.tsx. */
export const PAGE_PATH = "egg";

let navigate: BbNavigate | null = null;
let pagesMounted = 0;

/** Draws nothing; holds bb's navigate for the open command. */
export function NavigateHolder(): null {
  const current = useBbNavigate();
  useEffect(() => {
    navigate = current;
    return () => {
      if (navigate === current) navigate = null;
    };
  }, [current]);
  return null;
}

export const canOpenPage = (): boolean => navigate !== null;

/** Go to egg's page. Already there: do nothing, so the open room stays as it is. */
export function openPage(): void {
  if (pagesMounted > 0) return;
  navigate?.toPluginPanel(PAGE_PATH);
}

/** Wraps the page so the open command knows when it is already showing. */
export function countingMounts<P extends object>(Page: ComponentType<P>): ComponentType<P> {
  return function CountedPage(props: P) {
    useEffect(() => {
      pagesMounted += 1;
      return () => {
        pagesMounted -= 1;
      };
    }, []);
    return createElement(Page, props);
  };
}
