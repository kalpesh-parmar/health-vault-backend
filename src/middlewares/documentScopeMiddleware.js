function scopeDocumentFilterToAuthenticatedUser(req, _res, next) {
  req.body = req.body || {};
  req.body.filter = {
    ...(req.body.filter || {}),
    createdBy: req.auth.userId,
  };

  return next();
}

module.exports = { scopeDocumentFilterToAuthenticatedUser };
