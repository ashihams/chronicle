/** @type {import('eslint').Linter.Config} */
module.exports = {
  rules: {
    // CLI writes tables and JSON to stdout/stderr on purpose.
    'no-console': 'off',
  },
};
