module.exports = {
  preset: "ts-jest",
  // Default environment is node (API + lib unit tests). Component tests opt into
  // jsdom per-file via an `@jest-environment jsdom` docblock.
  testEnvironment: "node",
  testMatch: [
    "**/__tests__/**/*.test.ts",
    "**/__tests__/**/*.test.tsx",
    "**/*.test.ts",
    "**/*.test.tsx",
  ],
  moduleNameMapper: {
    "^@/(.*)$": "<rootDir>/$1",
  },
  collectCoverageFrom: [
    "lib/**/*.ts",
    "app/api/**/*.ts",
    "!**/*.test.ts",
    "!**/*.d.ts",
    "!**/node_modules/**",
  ],
};
