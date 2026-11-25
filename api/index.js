// Función serverless de Vercel: todas las rutas /api/* llegan aquí (ver vercel.json).
const { handleApi } = require('../lib/app');
module.exports = handleApi;
