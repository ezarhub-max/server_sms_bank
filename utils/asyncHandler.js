// utils/asyncHandler.js - Express doesn't forward rejected promises from
// async route handlers to the error middleware on its own; this wrapper
// does, so a thrown DB error becomes a clean 500 JSON response instead of
// an unhandled rejection / hung request.
module.exports = (fn) => (req, res, next) => fn(req, res, next).catch(next);
