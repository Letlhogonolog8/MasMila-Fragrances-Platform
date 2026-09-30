import { Router, type IRouter } from "express";
import healthRouter from "./health";
import catalogRouter from "./catalog";
import checkoutRouter from "./checkout";
import accountRouter from "./account";
import resellerRouter from "./reseller";
import adminRouter from "./admin";
import seoRouter from "./seo";

const router: IRouter = Router();

router.use(healthRouter);
router.use(seoRouter);
router.use(catalogRouter);
router.use(checkoutRouter);
router.use(accountRouter);
router.use(resellerRouter);
router.use(adminRouter);

export default router;
