// egg's frontend entry: one nav page.
import { definePluginApp } from "@get-bb/plugin-sdk/app";
import "./src/egg.css";
import { EggPage } from "./src/view.tsx";

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "egg",
    title: "egg",
    icon: "Egg",
    path: "egg",
    component: EggPage,
  });
});
