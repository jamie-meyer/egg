// egg's frontend entry: one nav page, and a command that opens it from
// anywhere in bb.
import { definePluginApp } from "@get-bb/plugin-sdk/app";
import "./src/egg.css";
import { DEFAULT_OPEN_KEY } from "./src/identity.ts";
import { canOpenPage, countingMounts, NavigateHolder, openPage, PAGE_PATH } from "./src/opener.tsx";
import { EggPage } from "./src/view.tsx";

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "egg",
    title: "egg",
    // Not a built-in icon name, so bb falls back to the plugin's own icon
    // (assets/egg.svg, named in the manifest's branding).
    icon: "egg-hatching",
    path: PAGE_PATH,
    component: countingMounts(EggPage),
  });
  app.slots.experimental_appOverlay({ id: "navigate", component: NavigateHolder });
  app.commands.register({
    id: "open",
    title: "egg: open its page",
    // Control+Option+E on macOS; rebindable in bb's keyboard settings.
    defaultShortcut: { key: DEFAULT_OPEN_KEY, control: true, alt: true },
    isAvailable: canOpenPage,
    run: openPage,
  });
});
