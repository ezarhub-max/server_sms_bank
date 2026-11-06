// middleware/adminAuth.js - protects /api/admin/* with a shared secret
// header, separate from end-user JWTs. Only people who run the server /
// have the ADMIN_KEY (you) can provision accounts or add months.

function adminAuth(req, res, next) {
  if (req.headers['x-admin-key'] !== process.env.ADMIN_KEY) {
    return res.status(403).json({ error: 'Invalid admin key' });
  }
  next();
}

module.exports = adminAuth;
