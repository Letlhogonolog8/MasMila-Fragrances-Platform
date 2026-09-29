import { Router, type IRouter } from "express";
import healthRouter from "./health";
import masmilaRouter from "./masmila";

const router: IRouter = Router();

router.use(healthRouter);
router.use(masmilaRouter);

export default router;
