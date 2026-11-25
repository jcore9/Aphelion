import { satteri } from "@astrojs/markdown-satteri";
import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";
import starlightLinksValidator from "starlight-links-validator";
import { leadingH1IsTitle, markdownLinksToPages } from "./src/pages";

export default defineConfig({
  markdown: {
    processor: satteri({
      mdastPlugins: [leadingH1IsTitle, markdownLinksToPages],
    }),
  },
  integrations: [
    starlight({
      title: "Aphelion",
      plugins: [starlightLinksValidator()],
      sidebar: [
        { label: "Plan", items: [{ autogenerate: { directory: "plan" } }] },
        {
          label: "Spike findings",
          items: [{ autogenerate: { directory: "spikes" } }],
        },
        {
          label: "Decision records",
          items: [{ autogenerate: { directory: "decisions" } }],
        },
      ],
    }),
  ],
});
