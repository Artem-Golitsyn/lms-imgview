import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isToolPreapproved } from "./approvals.js";

describe("isToolPreapproved", () => {
  it("allows a tool the user marked always allow", () => {
    const settings = { skipToolConfirmationPatterns: ["mcp/z-image:*", "mcp/playwright:browser_navigate"] };
    assert.equal(isToolPreapproved(settings, "mcp/z-image", "generate_image"), true);
    assert.equal(isToolPreapproved(settings, "mcp/playwright", "browser_navigate"), true);
    assert.equal(isToolPreapproved(settings, "mcp/playwright", "browser_click"), false);
  });

  it("does not let a star cross from the plugin id into the tool name", () => {
    const settings = { skipToolConfirmationPatterns: ["mcp/*"] };
    assert.equal(isToolPreapproved(settings, "mcp/z-image", "generate_image"), false);
  });

  it("allows every tool when confirmation is switched off", () => {
    assert.equal(isToolPreapproved({ neverAskForToolConfirmation: true }, undefined, "generate_image"), true);
  });

  it("asks when the tool has no plugin id or nothing was saved", () => {
    assert.equal(isToolPreapproved({ skipToolConfirmationPatterns: ["mcp/z-image:*"] }, undefined, "generate_image"), false);
    assert.equal(isToolPreapproved({}, "mcp/z-image", "generate_image"), false);
  });
});
