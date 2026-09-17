// Express 4 (the version this project uses) does NOT automatically catch
// errors thrown inside an `async` route handler - a rejected promise in a
// route just becomes an unhandled rejection and can crash the whole
// process. Wrapping every async route with this turns that into a normal
// error the catch-all handler in server.js can turn into a 500 response.
//
// Usage: router.get("/", asyncHandler(async (req, res) => { ... }))
function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

module.exports = { asyncHandler };
