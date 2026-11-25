import { docsLoader } from "@astrojs/starlight/loaders";
import { docsSchema } from "@astrojs/starlight/schema";
import { defineCollection } from "astro/content/config";
import { readFile } from "node:fs/promises";
import { titleFromH1 } from "./pages";

const starlightDocs = docsLoader();

export const collections = {
  docs: defineCollection({
    loader: {
      name: "aphelion-docs-in-place",
      load: (context) =>
        starlightDocs.load({
          ...context,
          parseData: async (props) => {
            if (props.data["title"] !== undefined || !props.filePath)
              return context.parseData(props);
            const title = titleFromH1(await readFile(props.filePath, "utf8"));
            return context.parseData({
              ...props,
              data: { ...props.data, title },
            });
          },
        }),
    },
    schema: docsSchema(),
  }),
};
