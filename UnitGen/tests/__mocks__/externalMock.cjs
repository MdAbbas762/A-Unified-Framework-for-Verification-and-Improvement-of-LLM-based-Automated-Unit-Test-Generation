// CommonJS universal mock for external packages (works with Jest resolver).
// Returns a proxy where any property access is a jest.fn().

const handler = {
  get(target, prop) {
    if (prop === "__esModule") return true;
    if (!(prop in target)) {
      target[prop] = jest.fn();
    }
    return target[prop];
  },
};

const proxy = new Proxy({}, handler);

// Support default import and named imports
module.exports = proxy;
module.exports.default = proxy;
module.exports.__esModule = true;