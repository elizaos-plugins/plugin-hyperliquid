// src/actions/spotTrade.ts
import {
  composeContext,
  elizaLogger,
  generateObjectDeprecated,
  ModelClass
} from "@elizaos/core";
import { Hyperliquid } from "hyperliquid";

// src/types.ts
import { z } from "zod";
var SpotOrderSchema = z.object({
  coin: z.string().min(1),
  is_buy: z.boolean(),
  sz: z.number().positive(),
  limit_px: z.number().positive().nullable(),
  reduce_only: z.boolean().default(false),
  order_type: z.object({
    limit: z.object({
      tif: z.enum(["Ioc", "Gtc"])
    })
  }).default({ limit: { tif: "Gtc" } })
});
var HyperliquidError = class extends Error {
  constructor(message, code, details) {
    super(message);
    this.code = code;
    this.details = details;
    this.name = "HyperliquidError";
  }
};
var PRICE_VALIDATION = {
  MARKET_ORDER: {
    MIN_RATIO: 0.5,
    // -50% from mid price
    MAX_RATIO: 1.5
    // +50% from mid price
  },
  LIMIT_ORDER: {
    WARNING_MIN_RATIO: 0.2,
    // -80% from mid price
    WARNING_MAX_RATIO: 5
    // +500% from mid price
  },
  SLIPPAGE: 0.01
  // 1% slippage for market orders
};

// src/templates.ts
var priceCheckTemplate = `Look at your LAST RESPONSE in the conversation where you confirmed which token price to check.
Based on ONLY that last message, extract the token symbol.

For example:
- "I'll check PIP price for you" -> { "symbol": "PIP" }
- "Let me check the price of HYPE" -> { "symbol": "HYPE" }
- "I'll get the current ETH price" -> { "symbol": "ETH" }

\`\`\`json
{
    "symbol": "<token symbol from your last message>"
}
\`\`\`

Note:
- Just return the token symbol (PIP, HYPE, ETH, etc.)
- Remove any suffixes like "-SPOT" or "USDC"
- If multiple tokens are mentioned, use the last one

Recent conversation:
{{recentMessages}}`;

// src/actions/spotTrade.ts
var spotTrade = {
  name: "SPOT_TRADE",
  similes: ["SPOT_ORDER", "SPOT_BUY", "SPOT_SELL"],
  description: "Place a spot trade order on Hyperliquid",
  validate: async (runtime) => {
    return !!runtime.getSetting("HYPERLIQUID_PRIVATE_KEY");
  },
  handler: async (runtime, message, state, _options, callback) => {
    try {
      const currentState = !state ? await runtime.composeState(message) : await runtime.updateRecentMessageState(state);
      const context = composeContext({
        state: currentState,
        template: priceCheckTemplate
      });
      const content = await generateObjectDeprecated({
        runtime,
        context,
        modelClass: ModelClass.SMALL
      });
      if (!content) {
        throw new HyperliquidError(
          "Could not parse trading parameters from conversation"
        );
      }
      elizaLogger.info(
        "Raw content from LLM:",
        JSON.stringify(content, null, 2)
      );
      const validatedOrder = SpotOrderSchema.parse(content);
      elizaLogger.info("Validated order:", validatedOrder);
      const sdk = new Hyperliquid({
        privateKey: runtime.getSetting("HYPERLIQUID_PRIVATE_KEY"),
        testnet: runtime.getSetting("HYPERLIQUID_TESTNET") === "true",
        enableWs: false
      });
      await sdk.connect();
      const [meta, assetCtxs] = await sdk.info.spot.getSpotMetaAndAssetCtxs();
      const tokenIndex = meta.tokens.findIndex(
        (token) => token.name.toUpperCase() === validatedOrder.coin.toUpperCase()
      );
      if (tokenIndex === -1) {
        throw new HyperliquidError(
          `Could not find token ${validatedOrder.coin}`
        );
      }
      const tokenInfo = meta.tokens[tokenIndex];
      elizaLogger.info("Found token:", tokenInfo.name);
      const marketIndex = assetCtxs.findIndex(
        (ctx) => ctx.coin === `${validatedOrder.coin}-SPOT`
      );
      if (marketIndex === -1) {
        throw new HyperliquidError(
          `Could not find market for ${validatedOrder.coin}`
        );
      }
      const marketCtx = assetCtxs[marketIndex];
      if (!marketCtx || !marketCtx.midPx) {
        throw new HyperliquidError(
          `Could not get market price for ${validatedOrder.coin}`
        );
      }
      const midPrice = Number(marketCtx.midPx);
      const isMarketOrder = !validatedOrder.limit_px;
      let finalPrice;
      if (isMarketOrder) {
        const slippage = PRICE_VALIDATION.SLIPPAGE;
        finalPrice = validatedOrder.is_buy ? midPrice * (1 + slippage) : midPrice * (1 - slippage);
        if (finalPrice < midPrice * PRICE_VALIDATION.MARKET_ORDER.MIN_RATIO || finalPrice > midPrice * PRICE_VALIDATION.MARKET_ORDER.MAX_RATIO) {
          throw new HyperliquidError(
            `Market order price (${finalPrice.toFixed(2)} USDC) is too far from market price (${midPrice.toFixed(2)} USDC). This might be due to low liquidity.`
          );
        }
      } else {
        finalPrice = validatedOrder.limit_px;
        if (validatedOrder.is_buy && finalPrice > midPrice) {
          throw new HyperliquidError(
            `Cannot place buy limit order at ${finalPrice.toFixed(2)} USDC because it's above market price (${midPrice.toFixed(2)} USDC). To execute immediately, use a market order. For a limit order, set a price below ${midPrice.toFixed(2)} USDC.`
          );
        } else if (!validatedOrder.is_buy && finalPrice < midPrice) {
          throw new HyperliquidError(
            `Cannot place sell limit order at ${finalPrice.toFixed(2)} USDC because it's below market price (${midPrice.toFixed(2)} USDC). To execute immediately, use a market order. For a limit order, set a price above ${midPrice.toFixed(2)} USDC.`
          );
        }
        if (finalPrice < midPrice * PRICE_VALIDATION.LIMIT_ORDER.WARNING_MIN_RATIO || finalPrice > midPrice * PRICE_VALIDATION.LIMIT_ORDER.WARNING_MAX_RATIO) {
          elizaLogger.warn(
            `Limit price (${finalPrice.toFixed(2)} USDC) is very different from market price (${midPrice.toFixed(2)} USDC). Make sure this is intentional.`,
            {
              finalPrice,
              midPrice,
              ratio: finalPrice / midPrice
            }
          );
        }
      }
      const rounded_px = Number(finalPrice.toFixed(tokenInfo.szDecimals));
      const orderRequest = {
        coin: `${validatedOrder.coin}-SPOT`,
        asset: 1e4 + marketIndex,
        is_buy: validatedOrder.is_buy,
        sz: validatedOrder.sz,
        limit_px: rounded_px,
        reduce_only: false,
        order_type: isMarketOrder ? { market: {} } : { limit: { tif: "Gtc" } }
      };
      elizaLogger.info("Placing order:", orderRequest);
      const result = await sdk.exchange.placeOrder(orderRequest);
      if (result.status === "ok" && result.response?.type === "order" && result.response.data?.statuses?.[0]?.error) {
        throw new HyperliquidError(
          result.response.data.statuses[0].error
        );
      }
      if (callback) {
        const action = validatedOrder.is_buy ? "buy" : "sell";
        const executionPrice = result.response?.data?.statuses?.[0]?.px || rounded_px;
        callback({
          text: `Successfully placed ${isMarketOrder ? "a market" : "a limit"} order to ${action} ${validatedOrder.sz} ${validatedOrder.coin} at ${executionPrice}`,
          content: result
        });
      }
      return true;
    } catch (error) {
      elizaLogger.error("Error placing spot order:", error);
      if (callback) {
        callback({
          text: `Error placing spot order: ${error.message}`,
          content: { error: error.message }
        });
      }
      return false;
    }
  },
  examples: [
    [
      {
        user: "{{user1}}",
        content: {
          text: "Buy 0.1 HYPE at 20 USDC"
        }
      },
      {
        user: "{{agent}}",
        content: {
          text: "I'll place a spot buy order for 0.1 HYPE at 20 USDC.",
          action: "SPOT_TRADE"
        }
      },
      {
        user: "{{agent}}",
        content: {
          text: "Successfully placed a limit order to buy 0.1 HYPE at 20 USDC"
        }
      }
    ],
    [
      {
        user: "{{user1}}",
        content: {
          text: "Sell 2 HYPE at 21 USDC"
        }
      },
      {
        user: "{{agent}}",
        content: {
          text: "I'll place a spot sell order for 2 HYPE at 21 USDC.",
          action: "SPOT_TRADE"
        }
      },
      {
        user: "{{agent}}",
        content: {
          text: "Successfully placed a limit order to sell 2 HYPE at 21 USDC"
        }
      }
    ]
  ]
};

// src/actions/priceCheck.ts
import {
  composeContext as composeContext2,
  elizaLogger as elizaLogger2,
  generateObjectDeprecated as generateObjectDeprecated2,
  ModelClass as ModelClass2
} from "@elizaos/core";
import { Hyperliquid as Hyperliquid2 } from "hyperliquid";
var priceCheck = {
  name: "PRICE_CHECK",
  similes: ["CHECK_PRICE", "GET_PRICE", "PRICE", "CURRENT_PRICE"],
  description: "Get current price for a token on Hyperliquid",
  validate: async () => true,
  // Public endpoint
  handler: async (runtime, message, state, _options, callback) => {
    try {
      const currentState = !state ? await runtime.composeState(message) : await runtime.updateRecentMessageState(state);
      const context = composeContext2({
        state: currentState,
        template: priceCheckTemplate
      });
      const content = await generateObjectDeprecated2({
        runtime,
        context,
        modelClass: ModelClass2.SMALL
      });
      if (!content?.symbol) {
        throw new HyperliquidError(
          "Could not determine which token price to check"
        );
      }
      elizaLogger2.info("Checking price for token:", content.symbol);
      const sdk = new Hyperliquid2({
        enableWs: false
      });
      await sdk.connect();
      const [meta, assetCtxs] = await sdk.info.spot.getSpotMetaAndAssetCtxs();
      const tokenIndex = meta.tokens.findIndex(
        (token) => token.name.toUpperCase() === content.symbol.toUpperCase()
      );
      if (tokenIndex === -1) {
        throw new HyperliquidError(
          `Could not find token ${content.symbol}`
        );
      }
      const marketIndex = assetCtxs.findIndex(
        (ctx) => ctx.coin === `${content.symbol}-SPOT`
      );
      if (marketIndex === -1) {
        throw new HyperliquidError(
          `Could not find market for ${content.symbol}`
        );
      }
      const marketCtx = assetCtxs[marketIndex];
      if (!marketCtx || !marketCtx.midPx) {
        throw new HyperliquidError(
          `Could not get market price for ${content.symbol}`
        );
      }
      const price = Number(marketCtx.midPx);
      const dayChange = ((price - Number(marketCtx.prevDayPx)) / Number(marketCtx.prevDayPx) * 100).toFixed(2);
      const volume = Number(marketCtx.dayNtlVlm).toFixed(2);
      if (callback) {
        callback({
          text: `${content.symbol} price: ${price.toFixed(2)} USDC (24h change: ${dayChange}%, volume: ${volume} USDC)`,
          content: {
            symbol: content.symbol,
            price,
            dayChange,
            volume
          }
        });
      }
      return true;
    } catch (error) {
      elizaLogger2.error("Error checking price:", error);
      if (callback) {
        callback({
          text: `Error checking price: ${error.message}`,
          content: { error: error.message }
        });
      }
      return false;
    }
  },
  examples: [
    [
      {
        user: "{{user1}}",
        content: {
          text: "What's the current price of PIP?"
        }
      },
      {
        user: "{{agent}}",
        content: {
          text: "I'll check the current PIP price for you.",
          action: "PRICE_CHECK"
        }
      },
      {
        user: "{{agent}}",
        content: {
          text: "PIP price: 19.73 USDC (24h change: -1.82%, volume: 1053445.75 USDC)"
        }
      }
    ]
  ]
};

// src/actions/cancelOrders.ts
import {
  elizaLogger as elizaLogger3
} from "@elizaos/core";
import { Hyperliquid as Hyperliquid3 } from "hyperliquid";
var cancelOrders = {
  name: "CANCEL_ORDERS",
  similes: ["CANCEL_ALL_ORDERS", "CANCEL", "CANCEL_ALL"],
  description: "Cancel all open orders on Hyperliquid",
  validate: async (runtime) => {
    return !!runtime.getSetting("HYPERLIQUID_PRIVATE_KEY");
  },
  handler: async (runtime, _message, _state, _options, callback) => {
    try {
      const sdk = new Hyperliquid3({
        privateKey: runtime.getSetting("HYPERLIQUID_PRIVATE_KEY"),
        testnet: runtime.getSetting("HYPERLIQUID_TESTNET") === "true",
        enableWs: false
      });
      await sdk.connect();
      elizaLogger3.info("Cancelling all open orders...");
      const result = await sdk.custom.cancelAllOrders();
      elizaLogger3.info("Cancel result:", result);
      if (callback) {
        const cancelledCount = result?.response?.data?.statuses?.length || 0;
        callback({
          text: cancelledCount > 0 ? `Successfully cancelled ${cancelledCount} open order${cancelledCount > 1 ? "s" : ""}` : "No open orders to cancel",
          content: result
        });
      }
      return true;
    } catch (error) {
      elizaLogger3.error("Error cancelling orders:", error);
      if (callback) {
        callback({
          text: `Error cancelling orders: ${error.message}`,
          content: { error: error.message }
        });
      }
      return false;
    }
  },
  examples: [
    [
      {
        user: "{{user1}}",
        content: {
          text: "Cancel all my orders"
        }
      },
      {
        user: "{{agent}}",
        content: {
          text: "I'll cancel all your open orders.",
          action: "CANCEL_ORDERS"
        }
      },
      {
        user: "{{agent}}",
        content: {
          text: "Successfully cancelled 2 open orders"
        }
      }
    ]
  ]
};

// src/index.ts
var hyperliquidPlugin = {
  name: "hyperliquid",
  description: "Hyperliquid plugin",
  actions: [spotTrade, priceCheck, cancelOrders],
  providers: [],
  evaluators: [],
  services: [],
  clients: []
};
var index_default = hyperliquidPlugin;
export {
  index_default as default,
  hyperliquidPlugin
};
//# sourceMappingURL=index.js.map