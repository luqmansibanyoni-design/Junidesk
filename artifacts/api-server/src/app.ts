import express, { type Express } from "express";
import cors from "cors";
import { clerkMiddleware } from "@clerk/express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";

const app: Express = express();

// Clerk must run before routes that call getAuth(req).
app.use(clerkMiddleware());

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use("/api", router);

// In production, serve the built JuniDesk frontend from the same origin as
// the API so browser requests and Clerk sessions share one host.
const publicDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../junidesk/dist/public",
);
app.use(express.static(publicDir));
app.get("*path", (_req, res, next) => {
  res.sendFile(path.join(publicDir, "index.html"), (error) => {
    if (error) next(error);
  });
});

export default app;
