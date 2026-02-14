import { describe, test, expect, jest } from "@jest/globals";


// Import AFTER mocks (required for ESM mocking)
const mod = await import("../sample/input.js");
const { add } = mod;

describe("add", () => {
  // Fallback prototype test (always present so suite is never empty)
  test("auto-generated (prototype)", () => {
    const a = 1;
    const b = 1;
    const result = add(a, b);
    expect(result).toBeDefined();
  });

  
  test("Adding two numbers", () => {
    {
      const a = 5;
      const result = add(a, 3);

      expect(result).toBe(8)
    }
  });


  test("Adding negative and positive numbers", () => {
    {
      const a = -2;
      const result = add(a, 4);

      expect(result).toBe(2)
    }
  });


  test("Adding zero to a number", () => {
    {
      const a = 0;
      const result = add(a, 5);

      expect(result).toBe(5)
    }
  });


  test("Adding two negative numbers", () => {
    {
      const a = -3;
      const result = add(a, -1);

      expect(result).toBe(-4)
    }
  });
});
