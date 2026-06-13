module.exports = {
  preset: "ts-jest",
  // Default environment stays node so the existing lib/API suites are
  // untouched. Component tests (*.test.tsx) opt into jsdom via a per-file
  // `@jest-environment jsdom` docblock.
  testEnvironment: "node",
  testMatch: [
    "**/__tests__/**/*.test.ts",
    "**/__tests__/**/*.test.tsx",
    "**/*.test.ts",
    "**/*.test.tsx",
  ],
  setupFilesAfterEnv: ["<rootDir>/jest.setup.ts"],
  moduleNameMapper: {
    "^@/(.*)$": "<rootDir>/$1",
  },
  collectCoverageFrom: [
    "lib/**/*.ts",
    "app/api/**/*.ts",
    "app/components/**/*.tsx",
    "!**/*.test.ts",
    "!**/*.test.tsx",
    "!**/*.d.ts",
    "!**/node_modules/**",
  ],
};
