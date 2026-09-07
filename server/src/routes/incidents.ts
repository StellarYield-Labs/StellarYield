import { Router, Request, Response } from "express";
import { incidentService, IncidentFilter } from "../services/incidentService";
import { incidentAutomationService } from "../services/incidentAutomationService";
import { parsePaginationLimit } from "../types/pagination";

const router = Router();

/**
 * GET /api/incidents
 *
 * Returns a paginated list of incidents ordered by `startedAt` descending.
 *
 * Query parameters:
 *   protocol  — filter by protocol name (optional)
 *   severity  — filter by severity (optional)
 *   type      — filter by incident type (optional)
 *   resolved  — "true" | "false" (optional)
 *   cursor    — opaque cursor from a previous response's `pagination.nextCursor` (optional)
 *   limit     — items per page, 1–100 (default 20)
 *
 * Response:
 *   {
 *     "data": [...incidents],
 *     "pagination": { "nextCursor": string|null, "hasMore": boolean, "limit": number }
 *   }
 */
router.get("/", async (req: Request, res: Response) => {
  try {
    const filter: IncidentFilter = {
      protocol: req.query.protocol as string | undefined,
      severity: req.query.severity as string | undefined,
      type: req.query.type as string | undefined,
      resolved:
        req.query.resolved === "true"
          ? true
          : req.query.resolved === "false"
            ? false
            : undefined,
    };
    const page = await incidentService.getIncidentsPaginated(filter, {
      cursor: req.query.cursor as string | undefined,
      limit: parsePaginationLimit(req.query.limit),
    });
    res.json(page);
  } catch {
    res.status(500).json({ error: "Failed to fetch incidents" });
  }
});

router.get("/:id", async (req: Request, res: Response) => {
  try {
    const incident = await incidentService.getIncidentById(req.params.id);
    if (!incident) {
      res.status(404).json({ error: "Incident not found" });
      return;
    }
    res.json(incident);
  } catch {
    res.status(500).json({ error: "Failed to fetch incident" });
  }
});

router.post("/", async (req: Request, res: Response) => {
  try {
    const {
      protocol,
      severity,
      type,
      title,
      description,
      affectedVaults,
      startedAt,
    } = req.body;
    if (
      !protocol ||
      !severity ||
      !type ||
      !title ||
      !description ||
      !startedAt
    ) {
      res.status(400).json({ error: "Missing required fields" });
      return;
    }
    const incident = await incidentService.createIncident({
      protocol,
      severity,
      type,
      title,
      description,
      affectedVaults: affectedVaults || [],
      startedAt: new Date(startedAt),
    });
    res.status(201).json(incident);
  } catch {
    res.status(500).json({ error: "Failed to create incident" });
  }
});

router.patch("/:id/resolve", async (req: Request, res: Response) => {
  try {
    const incident = await incidentService.resolveIncident(req.params.id);
    res.json(incident);
  } catch {
    res.status(500).json({ error: "Failed to resolve incident" });
  }
});

router.get("/:id/recommendations", async (req: Request, res: Response) => {
  try {
    const recommendations = await incidentService.getRecommendationsForIncident(
      req.params.id,
    );
    res.json(recommendations);
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch recommendations" });
  }
});

/**
 * PATCH /api/incidents/:id/state
 *
 * Update the incident state in the state machine.
 * This is used for manual state transitions (e.g., admin moves incident to MONITORING).
 *
 * Body: { state: "DETECTED" | "FROZEN" | "MONITORING" | "RECOVERY_CANDIDATE" | "RECOVERED" | "MANUALLY_RESOLVED" }
 */
router.patch("/:id/state", async (req: Request, res: Response) => {
  try {
    const { state } = req.body as { state?: string };
    if (!state) {
      res.status(400).json({ error: "state is required" });
      return;
    }

    const validStates = [
      "DETECTED",
      "FROZEN",
      "MONITORING",
      "RECOVERY_CANDIDATE",
      "RECOVERED",
      "MANUALLY_RESOLVED",
    ];
    if (!validStates.includes(state)) {
      res.status(400).json({
        error: `Invalid state. Must be one of: ${validStates.join(", ")}`,
      });
      return;
    }

    const incident = await incidentAutomationService.updateIncidentState(
      req.params.id,
      state as any,
    );
    res.json(incident);
  } catch (error) {
    res.status(500).json({ error: "Failed to update incident state" });
  }
});

/**
 * POST /api/incidents/:id/manual-resolve
 *
 * Manually resolve an incident (admin action).
 * This will:
 * - Unfreeze the protocol
 * - Mark incident as MANUALLY_RESOLVED
 * - Resolve the incident
 *
 * Body: { actor: string } (who is performing the action)
 */
router.post("/:id/manual-resolve", async (req: Request, res: Response) => {
  try {
    const { actor } = req.body as { actor?: string };
    if (!actor) {
      res.status(400).json({ error: "actor is required" });
      return;
    }

    const incident = await incidentAutomationService.manuallyResolveIncident(
      req.params.id,
      actor,
    );
    res.json(incident);
  } catch (error) {
    res.status(500).json({ error: "Failed to manually resolve incident" });
  }
});

/**
 * GET /api/incidents/protocol/:protocol/active
 *
 * Get the active (unresolved) incident for a specific protocol.
 * Returns null if no active incident exists.
 */
router.get(
  "/protocol/:protocol/active",
  async (req: Request, res: Response) => {
    try {
      const incident = await incidentAutomationService.getActiveIncident(
        req.params.protocol,
      );
      if (!incident) {
        res.status(404).json({ error: "No active incident for this protocol" });
        return;
      }
      res.json(incident);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch active incident" });
    }
  },
);

/**
 * POST /api/incidents/:id/record-healthy
 *
 * Record a healthy check for the protocol associated with this incident.
 * This advances the recovery counter and may transition the incident to RECOVERY_CANDIDATE.
 *
 * Body: { protocol: string }
 */
router.post("/:id/record-healthy", async (req: Request, res: Response) => {
  try {
    const { protocol } = req.body as { protocol?: string };
    if (!protocol) {
      res.status(400).json({ error: "protocol is required" });
      return;
    }

    await incidentAutomationService.recordProtocolHealthy(protocol);
    const incident = await incidentService.getIncidentById(req.params.id);
    res.json({ message: "Healthy check recorded", incident });
  } catch (error) {
    res.status(500).json({ error: "Failed to record healthy check" });
  }
});

/**
 * POST /api/incidents/:id/attempt-recovery
 *
 * Attempt automatic recovery for the protocol.
 * If stability window has passed and incident is in RECOVERY_CANDIDATE state,
 * this will unfreeze the protocol and mark the incident as RECOVERED.
 *
 * Body: { protocol: string }
 */
router.post("/:id/attempt-recovery", async (req: Request, res: Response) => {
  try {
    const { protocol } = req.body as { protocol?: string };
    if (!protocol) {
      res.status(400).json({ error: "protocol is required" });
      return;
    }

    const recovered =
      await incidentAutomationService.attemptAutoRecovery(protocol);
    const incident = await incidentService.getIncidentById(req.params.id);

    res.json({
      recovered,
      message: recovered
        ? "Protocol recovered successfully"
        : "Protocol not ready for recovery (stability window not met)",
      incident,
    });
  } catch (error) {
    res.status(500).json({ error: "Failed to attempt recovery" });
  }
});

export default router;
