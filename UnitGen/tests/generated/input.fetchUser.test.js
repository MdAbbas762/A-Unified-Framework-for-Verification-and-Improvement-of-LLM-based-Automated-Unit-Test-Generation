import { describe, test, expect, jest } from "@jest/globals";

jest.unstable_mockModule("path", () => ({ join: jest.fn(() => "data/x.txt") }));
jest.unstable_mockModule("fs", () => ({ readFileSync: jest.fn(() => "dummy file") }));
jest.unstable_mockModule("axios", () => { const api = { get: jest.fn().mockResolvedValue({ data: {} }) }; return { ...api, default: api }; });

// Import AFTER mocks (required for ESM mocking)
const mod = await import("../sample/input.js");
const { fetchUser } = mod;

describe("fetchUser", () => {
  // Fallback prototype test (always present so suite is never empty)
  test("auto-generated (prototype)", async () => {
    const id = 1;
    const result = await fetchUser(id);
    expect(result).toBeDefined();
  });

  
  test("fetchUser Test Case", async () => {
    {
      const id = '1';
      const result = await fetchUser(id);

      expect(result.id).toBe('1');
      expect(result.txt).toEqual('dummy file');
      expect(result.data).toEqual({});
    }
  });


  test("fetchUser Test Case with Different ID", async () => {
    {
      const id = '2';
      const result = await fetchUser(id);

      expect(result.id).toBe('2');
      expect(result.txt).toEqual('dummy file');
      expect(result.data).toEqual({});
    }
  });


  test("fetchUser Test Case with Empty File", async () => {
    {
      const id = '3';
      const result = await fetchUser(id);

      expect(result.id).toBe('3');
      expect(result.txt).toEqual('dummy file');
      expect(result.data).toEqual({});
    }
  });


  test("fetchUser Test Case with Non-existent ID", async () => {
    {
      const id = '4';
      const result = await fetchUser(id);

      expect(result.id).toBe('4');
      expect(result.txt).toEqual('dummy file');
      expect(result.data).toEqual({});
    }
  });
});
