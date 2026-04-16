const { db, pool } = require("./src/config/db");
const express = require("express");
require("dotenv").config();
const swaggerUi = require("swagger-ui-express");
const swaggerSpec = require("./src/config/swagger");

// import routes index
const routes = require("./src/routes");

const app = express();

app.use(express.json());
//check db connection
pool
  .connect()
  .then(() => console.log("database connect"))
  .catch((error) => console.log("error", error));

// all routes
app.use("/api", routes);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server started on port ${PORT}`);

  app.use("/swagger-ui", swaggerUi.serve, swaggerUi.setup(swaggerSpec));
  console.log(`http://localhost:${PORT}/swagger-ui`);
});
