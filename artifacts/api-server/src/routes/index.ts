import { Router, type IRouter } from "express";
import healthRouter from "./health";
import adminRouter from "./admin";
import ticketsRouter from "./tickets";

const router: IRouter = Router();

router.use(healthRouter);
router.use(ticketsRouter);
router.use(adminRouter);

export default router;
