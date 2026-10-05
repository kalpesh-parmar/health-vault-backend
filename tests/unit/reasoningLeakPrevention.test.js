const { stripThinking } = require("../../src/utils/textCleanUtils");
const { ollamaClient } = require("../../src/clients/ollamaClient");

describe("Phase 1 Contract - Reasoning Leak Prevention & Sanitization", () => {
  describe("stripThinking and sanitizeLLMOutput tag coverage", () => {
    test("strips standard <think>...</think> closed tags", () => {
      const input = "<think>Some reasoning</think>Normal Hemoglobin";
      expect(stripThinking(input)).toBe("Normal Hemoglobin");
    });

    test("strips unclosed <think> tags", () => {
      const input = "<think>Incomplete reasoning without end tag";
      expect(stripThinking(input)).toBe("");
    });

    // Marked as failing / expected failure until Phase 1 implements sanitizeLLMOutput with <thinking> and <reasoning>
    test("FAILING: strips <thinking>...</thinking> and <reasoning>...</reasoning> blocks", () => {
      const input1 = "<thinking>Deep reasoning block</thinking>Clinical summary";
      const input2 = "<reasoning>Detailed deduction</reasoning>Clinical summary";
      expect(stripThinking(input1)).toBe("Clinical summary");
      expect(stripThinking(input2)).toBe("Clinical summary");
    });

    test("FAILING: strips unclosed <thinking> and <reasoning> blocks", () => {
      const input1 = "<thinking>Unclosed thinking block cut off";
      const input2 = "<reasoning>Unclosed reasoning block cut off";
      expect(stripThinking(input1)).toBe("");
      expect(stripThinking(input2)).toBe("");
    });
  });

  describe("ollamaClient reasoning resurrection behavior", () => {
    test("FAILING: should never resurrect primaryText when stripped result is empty", () => {
      const rawData = {
        message: {
          content: "<think>Only internal reasoning here, no final answer</think>",
        },
      };

      // In current code, this returns "<think>Only internal reasoning here, no final answer</think>" because of line 90 resurrection!
      // In Phase 1, it must never contain <think> or leaked reasoning.
      const result = ollamaClient.extractResponseText(rawData, "chat");
      expect(result).not.toContain("<think>");
      expect(result).not.toContain("internal reasoning");
    });
  });

  describe("Translation output script validation (Gujarati >= 50% script check)", () => {
    function validateGujaratiScript(text) {
      if (!text || typeof text !== "string") return false;
      const gujaratiChars = (text.match(/[\u0A80-\u0AFF]/g) || []).length;
      const latinLetters = (text.match(/[a-zA-Z]/g) || []).length;
      const totalLetters = gujaratiChars + latinLetters;
      if (totalLetters === 0) return false;
      return gujaratiChars / totalLetters >= 0.5;
    }

    test("validates valid Gujarati text with English entities", () => {
      const validGujarati = "દર્દીનો Hemoglobin રિપોર્ટ સામાન્ય છે. Metformin 500mg ચાલુ રાખવી.";
      expect(validateGujaratiScript(validGujarati)).toBe(true);
    });

    test("rejects leaked English reasoning trace masquerading as translation", () => {
      const leakedReasoning =
        "Okay, let's tackle this translation request. The user provided: Medical laboratory report summary.";
      expect(validateGujaratiScript(leakedReasoning)).toBe(false);
    });
  });
});
