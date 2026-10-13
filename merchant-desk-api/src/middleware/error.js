const { ZodError } = require('zod');
const { HttpError } = require('../errors');

const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function notFound(req, res) {
  res.status(404).json({ error: 'Not found' });
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
  if (err instanceof ZodError) {
    return res.status(400).json({
      error: 'Check the highlighted fields',
      fields: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message }))
    });
  }
  if (err && err.name === 'CastError') return res.status(400).json({ error: 'Invalid id' });
  if (err && err.code === 11000) return res.status(409).json({ error: 'That value is already in use' });
  if (err && err.name === 'MulterError') return res.status(400).json({ error: err.message });
  console.error(err);
  return res.status(500).json({ error: 'Something went wrong on our side' });
}

module.exports = { ah, notFound, errorHandler };
