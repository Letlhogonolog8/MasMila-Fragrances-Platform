import { Router, type IRouter } from "express";
import {
  GetClientIpDiagnosticResponse,
  GetJobOverviewResponse,
  GetPaymentEventParams,
  GetPaymentEventResponse,
  ListPaymentEventsQueryParams,
  ListPaymentEventsResponse,
  ResolvePaymentEventBody,
  ResolvePaymentEventParams,
  ResolvePaymentEventResponse,
} from "@workspace/api-zod";
import { requireAdmin } from "../lib/auth";
import { listPaymentEvents, paymentEventDetail, resolvePaymentEvent } from "../lib/payment-review";
import { recentJobRuns } from "../lib/jobs";
import { clientIp, clientIpSource, trustedProxyHops } from "../lib/client-ip";
import { iso } from "../lib/http";

/** Payment review, job status and deployment diagnostics. Administrators only. */
const router: IRouter = Router();

router.use("/admin", requireAdmin);

router.get("/admin/payment-events", async (req, res) => {
  const filter = ListPaymentEventsQueryParams.parse(req.query);
  res.json(ListPaymentEventsResponse.parse(await listPaymentEvents(filter)));
});

router.get("/admin/payment-events/:id", async (req, res) => {
  const { id } = GetPaymentEventParams.parse(req.params);
  res.json(GetPaymentEventResponse.parse(await paymentEventDetail(id)));
});

router.post("/admin/payment-events/:id/resolve", async (req, res) => {
  const { id } = ResolvePaymentEventParams.parse(req.params);
  const body = ResolvePaymentEventBody.parse(req.body);
  res.json(ResolvePaymentEventResponse.parse(await resolvePaymentEvent(id, body, req.currentUser!)));
});

router.get("/admin/jobs", async (_req, res) => {
  const { runs, months } = await recentJobRuns();
  res.json(
    GetJobOverviewResponse.parse({
      months: months.map((m) => ({
        period: m.period,
        status: m.status,
        attempts: m.attempts,
        lastError: m.lastError,
        startedAt: iso(m.startedAt),
        finishedAt: iso(m.finishedAt),
        leaseExpiresAt: iso(m.leaseExpiresAt),
        resellerCount: m.resellerCount,
      })),
      runs: runs.map((r) => ({
        id: r.id,
        job: r.job,
        period: r.period,
        trigger: r.trigger,
        attempt: r.attempt,
        status: r.status,
        startedAt: r.startedAt.toISOString(),
        finishedAt: iso(r.finishedAt),
        error: r.error,
        result: r.result,
      })),
    }),
  );
});

/** What this server sees of the caller's address: use it to verify TRUSTED_PROXY_HOPS on a new host. */
router.get("/admin/diagnostics/client-ip", (req, res) => {
  const header = (name: string) => {
    const v = req.headers[name];
    return (Array.isArray(v) ? v.join(", ") : v) ?? null;
  };
  res.json(
    GetClientIpDiagnosticResponse.parse({
      clientIp: clientIp(req),
      source: clientIpSource() === "netlify" ? "netlify (x-nf-client-connection-ip)" : `socket + ${trustedProxyHops()} trusted proxy hop(s)`,
      trustedProxyHops: trustedProxyHops(),
      socketAddress: req.socket?.remoteAddress ?? null,
      forwardedFor: header("x-forwarded-for"),
      netlifyClientIp: header("x-nf-client-connection-ip"),
    }),
  );
});

export default router;
