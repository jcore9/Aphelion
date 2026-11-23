import type { ServerPlugin } from "@aphelion/plugin-sdk";

export default {
  async start(ctx) {
    ctx.log("plugin started");
    await ctx.events.subscribe("approval.requested", (data) => {
      ctx.log(`an approval was requested: ${JSON.stringify(data)}`);
    });
  },
} satisfies ServerPlugin;
