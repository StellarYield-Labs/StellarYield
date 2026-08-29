import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, Zap, Loader2, AlertTriangle, RefreshCw, Clock, Info, ShieldAlert } from "lucide-react";
import TxStatusTimeline from "../../components/transaction/TxStatusTimeline";
import { zapDeposit } from "../../services/soroban";
import type { TxPhase } from "../../services/transactionPhase";
import { TX_PHASE_PIPELINE } from "../../services/transactionPhase";
import { fetchSwapQuote, verifySwapQuote, isZapQuoteExpired } from "./fetchSwapQuote";
import { minAmountAfterSlippage } from "./slippage";
import { parseDecimalToStroops, formatStroopsToDecimal } from "./amount";
import {
  buildSelectableZapAssetsFromMetadata,
  fetchZapSupportedAssetsMetadata,
  getVaultContractIdFromEnv,
  getVaultTokenFromEnv,
  loadZapAssetOptions,
  mergeVaultIntoZapSelectableAssets,
  shouldLoadZapMetadataFromApi,
} from "./assets";
import type { ZapAssetOption, ZapQuoteResponse } from "./types";
import { useSettings } from "../settings/SettingsContext";
import { resolveSlippage } from "../settings/types";
import DepositRouteMaterialImpactWarning from "./DepositRouteMaterialImpactWarning";

export interface ZapDepositPanelProps {
  walletAddress: string | null;
}

const MIN_SLIPPAGE = 0.1;
const MAX_SLIPPAGE = 15;
const STALE_QUOTE_AGE_MS = 60_000;
const FALLBACK_SOURCE = "fallback_rate";

function quoteAgeSeconds(quotedAt: string): number {
  return Math.floor((Date.now() - new Date(quotedAt).getTime()) / 1000);
}

function formatExpiryCountdown(expiresAt?: string): string {
  if (!expiresAt) return "";
  const ms = new Date(expiresAt).getTime() - Date.now();
  if (ms <= 0) return "expired";
  const s = Math.ceil(ms / 1000);
  if (s < 60) return `${s}s left`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${m}m ${rem}s left`;
}

export default function ZapDepositPanel({ walletAddress }: ZapDepositPanelProps) {
  const useApiAssets = shouldLoadZapMetadataFromApi();
  const { settings } = useSettings();
  const settingsSlippage = resolveSlippage(settings);

  const initialVault = useMemo(() => getVaultTokenFromEnv(), []);
  const initialVaultContractId = useMemo(() => getVaultContractIdFromEnv(), []);

  const [vaultToken, setVaultToken] = useState<ZapAssetOption>(initialVault);
  const [vaultContractId, setVaultContractId] = useState(initialVaultContractId);
  const [selectableAssets, setSelectableAssets] = useState<ZapAssetOption[]>(() =>
    mergeVaultIntoZapSelectableAssets(loadZapAssetOptions(), initialVault),
  );

  useEffect(() => {
    if (!useApiAssets) return;
    let cancelled = false;
    void fetchZapSupportedAssetsMetadata().then((meta) => {
      if (cancelled || !meta) return;
      setVaultToken(meta.vaultToken);
      setVaultContractId(meta.vaultContractId);
      setSelectableAssets(buildSelectableZapAssetsFromMetadata(meta));
    });
    return () => {
      cancelled = true;
    };
  }, [useApiAssets]);

  const [inputAsset, setInputAsset] = useState<ZapAssetOption | null>(
    () => mergeVaultIntoZapSelectableAssets(loadZapAssetOptions(), initialVault)[0] ?? null,
  );

  useEffect(() => {
    if (!selectableAssets.length) return;
    if (
      !inputAsset ||
      !selectableAssets.some((a) => a.contractId === inputAsset.contractId)
    ) {
      const next = selectableAssets[0] ?? null;
      Promise.resolve().then(() => setInputAsset(next));
    }
  }, [inputAsset, selectableAssets]);

  const [amount, setAmount] = useState("");
  const [status, setStatus] = useState<"idle" | "loading" | "success" | "error">("idle");
  const [txPhase, setTxPhase] = useState<TxPhase>("idle");
  const lastProgressPhaseRef = useRef<TxPhase>("idle");
  const [lastProgressPhase, setLastProgressPhase] = useState<TxPhase>("idle");
  const [txHash, setTxHash] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [verifyError, setVerifyError] = useState("");
  const [quoteLoading, setQuoteLoading] = useState(false);
  const [expectedOut, setExpectedOut] = useState<bigint | null>(null);
  const [quotePath, setQuotePath] = useState<string>("");
  const [quoteSource, setQuoteSource] = useState<string>("");
  const [quoteData, setQuoteData] = useState<ZapQuoteResponse | null>(null);
  const [slippageTolerance, setSlippageTolerance] = useState(settingsSlippage);
  const [showSlippageEdit, setShowSlippageEdit] = useState(false);
  const [fallbackAck, setFallbackAck] = useState(false);
  const [nowTick, setNowTick] = useState(Date.now());

  const needsSwap = inputAsset?.contractId !== vaultToken.contractId;

  // Live tick for expiry countdown (1s)
  useEffect(() => {
    if (!quoteData?.expiresAt) return;
    const id = setInterval(() => setNowTick(Date.now()), 1000);
    return () => clearInterval(id);
  }, [quoteData?.expiresAt]);

  const refreshQuote = useCallback(async () => {
    if (!inputAsset || !amount || !vaultToken.contractId) {
      setExpectedOut(null);
      setQuotePath("");
      setQuoteData(null);
      return;
    }
    let stroops: bigint;
    try {
      stroops = parseDecimalToStroops(amount, inputAsset.decimals);
    } catch {
      setExpectedOut(null);
      return;
    }
    if (stroops <= 0n) {
      setExpectedOut(null);
      return;
    }

    setQuoteLoading(true);
    setError("");
    setVerifyError("");
    try {
      if (!needsSwap) {
        setExpectedOut(stroops);
        setQuotePath(`${inputAsset.symbol} (no swap)`);
        setQuoteSource("direct");
        setQuoteData(null);
        setFallbackAck(false);
      } else {
        const q = await fetchSwapQuote({
          inputTokenContract: inputAsset.contractId,
          vaultTokenContract: vaultToken.contractId,
          amountInStroops: stroops.toString(),
          inputDecimals: inputAsset.decimals,
          vaultDecimals: vaultToken.decimals,
          slippageTolerance: slippageTolerance / 100,
        });
        setExpectedOut(BigInt(q.expectedAmountOutStroops));
        setQuotePath(q.path.map((h) => h.label ?? h.contractId.slice(0, 6)).join(" → "));
        setQuoteSource(q.source);
        setQuoteData(q);
        // Reset fallback ack whenever we get a new quote; require explicit ack for fallback
        setFallbackAck(q.source !== FALLBACK_SOURCE && !q.isFallback);
        if (q.isFallback || q.source === FALLBACK_SOURCE) setFallbackAck(false);
      }
    } catch (e) {
      setExpectedOut(null);
      setError(e instanceof Error ? e.message : "Could not load quote");
      setQuoteData(null);
    } finally {
      setQuoteLoading(false);
    }
  }, [amount, inputAsset, needsSwap, slippageTolerance, vaultToken]);

  useEffect(() => {
    const t = setTimeout(() => {
      void refreshQuote();
    }, 350);
    return () => clearTimeout(t);
  }, [refreshQuote]);

  const minOut = useMemo(() => {
    if (expectedOut === null || expectedOut <= 0n) return null;
    return minAmountAfterSlippage(expectedOut, slippageTolerance);
  }, [expectedOut, slippageTolerance]);

  const isExpired = useMemo(() => {
    if (!quoteData) return false;
    // Prefer server-provided expiresAt + ttlMs envelope for deterministic expiry
    if (quoteData.expiresAt) return isZapQuoteExpired(quoteData, nowTick);
    // Fallback to legacy staleness
    return quoteAgeSeconds(quoteData.quotedAt) > STALE_QUOTE_AGE_MS / 1000;
  }, [quoteData, nowTick]);

  const isStale = useMemo(() => {
    if (!quoteData) return false;
    if (isExpired) return true;
    // Also treat quote as stale if nearing expiry (80% of TTL) or older than 30s
    const ttl = quoteData.ttlMs ?? STALE_QUOTE_AGE_MS;
    const ageMs = nowTick - new Date(quoteData.quotedAt).getTime();
    if (ageMs > ttl * 0.8) return true;
    return quoteAgeSeconds(quoteData.quotedAt) > STALE_QUOTE_AGE_MS / 1000;
  }, [quoteData, isExpired, nowTick]);

  const isFallback = useMemo(() => {
    if (!quoteData) return false;
    return quoteData.isFallback || quoteData.source === FALLBACK_SOURCE;
  }, [quoteData]);

  // Slippage edge warnings
  const slippageEdge = useMemo(() => {
    if (slippageTolerance < 0.1) return { level: "low", msg: "Very low slippage — transaction may revert if price moves slightly." };
    if (slippageTolerance > 5) return { level: "high", msg: "High slippage tolerance increases risk of unfavorable execution price." };
    if (slippageTolerance > 2) return { level: "elevated", msg: "Elevated slippage — consider lowering for tighter price protection." };
    return null;
  }, [slippageTolerance]);

  const emitPhase = useCallback((p: TxPhase) => {
    setTxPhase(p);
    if (p !== "success" && p !== "failure") {
      lastProgressPhaseRef.current = p;
      setLastProgressPhase(p);
    }
  }, []);

  const handleSlippageChange = useCallback((value: number) => {
    const clamped = Math.min(MAX_SLIPPAGE, Math.max(MIN_SLIPPAGE, value));
    setSlippageTolerance(clamped);
  }, []);

  const handleZap = useCallback(async () => {
    if (!walletAddress || !inputAsset || !vaultContractId || !vaultToken.contractId) return;
    let amountIn: bigint;
    try {
      amountIn = parseDecimalToStroops(amount, inputAsset.decimals);
    } catch {
      setError("Enter a valid amount");
      return;
    }
    if (amountIn <= 0n) return;
    if (minOut === null || minOut <= 0n) {
      setError("Wait for a valid quote or reduce slippage");
      return;
    }

    // ── Safety envelope: local pre-checks before on-chain execution ──
    if (needsSwap) {
      if (!quoteData) {
        setError("No quote available — please wait for a fresh quote.");
        return;
      }
      if (isExpired) {
        setVerifyError("Quote expired — please click Requote for fresh rates. Execution is blocked with stale assumptions.");
        setError("Quote expired. Requote required.");
        return;
      }
      if (isFallback && !fallbackAck) {
        setVerifyError("Fallback quote requires explicit acknowledgement of estimated-rate risk. Check the acknowledgement box or click Requote to try for a router-simulated quote.");
        setError("Fallback quote — acknowledgement required.");
        return;
      }
      // Verify with backend: expiry, asset-pair binding, freeze after quote, fallback distinction, signature
      try {
        setVerifyError("");
        const verify = await verifySwapQuote({
          quote: quoteData,
          inputTokenContract: inputAsset.contractId,
          vaultTokenContract: vaultToken.contractId,
          amountInStroops: amountIn.toString(),
          protocol: quoteData.protocol,
          allowFallback: fallbackAck,
        });
        if (!verify.valid) {
          const msg = verify.reason || verify.message || "Quote verification failed.";
          setVerifyError(`${msg}${verify.requiresRequote ? " Please requote." : ""}`);
          setError(msg);
          if (verify.code === "QUOTE_EXPIRED" || verify.code === "QUOTE_STALE" || verify.code === "FROZEN_AFTER_QUOTE" || verify.code === "ASSET_MISMATCH" || verify.code === "ROUTE_CHANGED") {
            // Auto-prompt requote could be here; we surface clear messaging
          }
          return;
        }
      } catch (e) {
        setVerifyError(e instanceof Error ? e.message : "Quote verification failed. Please requote.");
        setError(e instanceof Error ? e.message : "Quote verification failed.");
        return;
      }
    }

    lastProgressPhaseRef.current = "idle";
    setLastProgressPhase("idle");
    setTxPhase("idle");
    setTxHash(null);
    setStatus("loading");
    setError("");
    setVerifyError("");
    try {
      const result = await zapDeposit(
        walletAddress,
        {
          inputTokenContract: inputAsset.contractId,
          vaultTokenContract: vaultToken.contractId,
          vaultContractId,
          amountIn,
          minAmountOut: minOut,
          minSharesOut: minOut,
        },
        emitPhase,
        false,
        settings,
      );
      if (!result.success) {
        throw new Error(result.error || "Transaction failed");
      }
      setTxHash(result.hash ?? null);
      setStatus("success");
      setAmount("");
      // Invalidate quote after successful execution
      setQuoteData(null);
      setExpectedOut(null);
    } catch (err) {
      setStatus("error");
      setError(err instanceof Error ? err.message : "Transaction failed");
    }
  }, [
    walletAddress,
    inputAsset,
    vaultContractId,
    vaultToken.contractId,
    amount,
    minOut,
    emitPhase,
    settings,
    needsSwap,
    quoteData,
    isExpired,
    isFallback,
    fallbackAck,
  ]);

  const retryZap = useCallback(() => {
    setError("");
    setVerifyError("");
    void handleZap();
  }, [handleZap]);

  const configOk =
    Boolean(vaultContractId) &&
    Boolean(vaultToken.contractId) &&
    selectableAssets.length > 0;

  // Execution blocked reasons for UI
  const executionBlocked = useMemo(() => {
    if (!needsSwap) return null;
    if (!quoteData) return "Waiting for quote…";
    if (isExpired) return `Quote expired (TTL ${quoteData.ttlMs ? Math.round(quoteData.ttlMs / 1000) + "s" : "30s"}) — requote required.`;
    if (isFallback && !fallbackAck) return "Fallback quote — acknowledgement required before execution.";
    if (isStale) return "Quote is stale — requote recommended for best price.";
    return null;
  }, [needsSwap, quoteData, isExpired, isFallback, fallbackAck, isStale]);

  if (!walletAddress) {
    return (
      <div className="bg-white/5 backdrop-blur-xl rounded-2xl border border-white/10 p-8 text-center">
        <Zap className="w-12 h-12 text-yellow-400 mx-auto mb-4" />
        <h3 className="text-xl font-bold text-white mb-2">Zap into vault</h3>
        <p className="text-gray-400">Connect your wallet to swap and deposit in one transaction</p>
      </div>
    );
  }

  return (
    <div className="bg-white/5 backdrop-blur-xl rounded-2xl border border-white/10 p-6 max-w-md mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-2">
          <Zap className="w-5 h-5 text-yellow-400" />
          <h3 className="text-lg font-bold text-white">Zap deposit</h3>
        </div>
        <button
          type="button"
          onClick={() => void refreshQuote()}
          className="p-2 rounded-lg bg-white/10 hover:bg-white/20 text-gray-300"
          title="Refresh quote (requote)"
        >
          <RefreshCw className={`w-4 h-4 ${quoteLoading ? "animate-spin" : ""}`} />
        </button>
      </div>

      {!configOk && (
        <div className="mb-4 text-amber-200/90 text-sm flex gap-2 items-start">
          <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
          <span>
            Set <code className="text-amber-100">VITE_CONTRACT_ID</code>,{" "}
            <code className="text-amber-100">VITE_VAULT_TOKEN_CONTRACT_ID</code>, and asset contract
            IDs (or <code className="text-amber-100">VITE_ZAP_ASSETS_JSON</code>) in your env.
          </span>
        </div>
      )}

      {/* Fallback quote warning — distinct from router-simulated */}
      {isFallback && needsSwap && (
        <div className="mb-4 flex items-start gap-2 text-amber-200/90 text-sm bg-amber-500/10 border border-amber-500/30 rounded-lg p-3">
          <ShieldAlert className="w-4 h-4 shrink-0 mt-0.5 text-amber-400" />
          <div className="flex-1">
            <p className="font-medium text-amber-300">Fallback quote active</p>
            <p className="text-xs text-amber-200/70 mt-1">
              Router simulation unavailable. This is an <span className="font-semibold text-amber-200">estimated rate</span> — actual output may differ and slippage protection is less precise. Not silently treated as a simulated route.
            </p>
            <label className="mt-2 flex items-start gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={fallbackAck}
                onChange={(e) => setFallbackAck(e.target.checked)}
                className="mt-0.5 accent-amber-500"
              />
              <span className="text-xs text-amber-200/90">
                I understand this is a fallback estimate and accept the additional execution risk.
              </span>
            </label>
            {!fallbackAck && (
              <p className="text-[11px] text-amber-300/80 mt-1">
                Execution is blocked until you acknowledge or <button type="button" onClick={() => void refreshQuote()} className="underline font-medium">Requote</button> for a router-simulated price.
              </p>
            )}
            <p className="text-[11px] text-amber-200/50 mt-1">
              Quote ID: {quoteData?.quoteId?.slice(0, 8) ?? "—"} · Source: {quoteSource} · Protocol: {quoteData?.protocol ?? "default"}
            </p>
          </div>
        </div>
      )}

      {/* Stale / Expired quote warning with requote action */}
      {needsSwap && quoteData && isExpired && !quoteLoading && (
        <div className="mb-4 flex items-start gap-2 text-red-200/90 text-sm bg-red-500/10 border border-red-500/30 rounded-lg p-3">
          <Clock className="w-4 h-4 shrink-0 mt-0.5 text-red-400" />
          <div className="flex-1">
            <p className="font-medium text-red-300">Stale quote</p>
            <p className="text-xs text-red-300/80 -mt-1 mb-1">Quote expired — requote required</p>
            <p className="text-xs text-red-200/70 mt-1">
              This quote expired at <span className="font-mono text-red-200">{quoteData.expiresAt ? new Date(quoteData.expiresAt).toLocaleTimeString() : "unknown"}</span> (TTL {quoteData.ttlMs ? `${Math.round(quoteData.ttlMs / 1000)}s` : "30s"}). Assumptions (route, TVL, freeze state) are no longer valid. Execution is <span className="font-semibold">blocked</span>.
            </p>
            <button
              type="button"
              onClick={() => void refreshQuote()}
              className="mt-2 text-xs px-3 py-1 rounded bg-red-500/20 hover:bg-red-500/30 text-red-200 border border-red-500/30"
            >
              Requote for fresh rate
            </button>
            <p className="text-[11px] text-red-200/50 mt-1">
              Quote ID: {(quoteData.quoteId ?? "—").slice(0, 8)} · Quoted {quoteAgeSeconds(quoteData.quotedAt)}s ago · Signature: {(quoteData.quoteSignature ?? "—").slice(0, 8)}…
            </p>
          </div>
        </div>
      )}

      {needsSwap && quoteData && isStale && !isExpired && !quoteLoading && !isFallback && (
        <div className="mb-4 flex items-start gap-2 text-orange-200/90 text-sm bg-orange-500/10 border border-orange-500/30 rounded-lg p-3">
          <Clock className="w-4 h-4 shrink-0 mt-0.5 text-orange-400" />
          <div className="flex-1">
            <p className="font-medium text-orange-300">Stale quote — requote recommended</p>
            <p className="text-xs text-orange-200/70 mt-1">
              Quote is {quoteAgeSeconds(quoteData.quotedAt)}s old{quoteData.ttlMs ? ` (TTL ${Math.round(quoteData.ttlMs / 1000)}s, expires ${formatExpiryCountdown(quoteData.expiresAt)})` : ""}. Market conditions, TVL, or route may have shifted. Execution will be verified on-chain but requoting improves price accuracy.
            </p>
            <div className="mt-2 flex gap-2">
              <button
                type="button"
                onClick={() => void refreshQuote()}
                className="text-xs px-3 py-1 rounded bg-orange-500/20 hover:bg-orange-500/30 text-orange-200 border border-orange-500/30"
              >
                Requote
              </button>
              <span className="text-[11px] text-orange-200/50 self-center">
                Or proceed — verification will still check freeze/expiry before submitting.
              </span>
            </div>
          </div>
        </div>
      )}

      {/* Verify error: freeze after quote, asset mismatch, signature invalid, etc. */}
      {verifyError && (
        <div className="mb-4 flex items-start gap-2 text-red-200/90 text-sm bg-red-500/10 border border-red-500/30 rounded-lg p-3">
          <ShieldAlert className="w-4 h-4 shrink-0 mt-0.5 text-red-400" />
          <div className="flex-1">
            <p className="font-medium text-red-300">Quote verification failed</p>
            <p className="text-xs text-red-200/70 mt-1">{verifyError}</p>
            {(verifyError.toLowerCase().includes("requote") || verifyError.toLowerCase().includes("expired") || verifyError.toLowerCase().includes("frozen")) && (
              <button
                type="button"
                onClick={() => void refreshQuote()}
                className="mt-2 text-xs px-3 py-1 rounded bg-red-500/20 hover:bg-red-500/30 text-red-200 border border-red-500/30"
              >
                Requote now
              </button>
            )}
          </div>
        </div>
      )}

      <div className="bg-white/5 rounded-xl p-4 mb-2">
        <label className="text-sm text-gray-400 mb-2 block">You pay</label>
        <div className="flex gap-3">
          <select
            value={inputAsset?.contractId ?? ""}
            onChange={(e) => {
              const a = selectableAssets.find((x) => x.contractId === e.target.value);
              if (a) setInputAsset(a);
            }}
            className="bg-white/10 text-white rounded-lg px-3 py-2 border border-white/10 max-w-[40%]"
            disabled={!selectableAssets.length}
          >
            {selectableAssets.map((t) => (
              <option key={t.contractId} value={t.contractId}>
                {t.symbol}
              </option>
            ))}
          </select>
          <input
            type="text"
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="0.00"
            className="flex-1 bg-transparent text-white text-right text-2xl outline-none"
          />
        </div>
      </div>

      <div className="flex justify-center my-2">
        <div className="bg-white/10 rounded-full p-2">
          <ArrowDown className="w-4 h-4 text-gray-400" />
        </div>
      </div>

      <div className="bg-white/5 rounded-xl p-4 mb-4 space-y-2">
        <label className="text-sm text-gray-400 block">Expected to receive (before deposit)</label>
        <div className="flex items-center justify-between gap-2">
          <span className="text-white font-medium">
            {expectedOut !== null && expectedOut > 0n
              ? `${formatStroopsToDecimal(expectedOut, vaultToken.decimals)} ${vaultToken.symbol}`
              : quoteLoading
                ? "…"
                : "—"}
          </span>
          <span className="text-gray-500 text-xs text-right">
            {needsSwap ? "Vault token after swap" : "Vault token"}
          </span>
        </div>

        {/* Min output after slippage */}
        {minOut !== null && minOut > 0n && (
          <p className="text-xs text-gray-400">
            Min. after {slippageTolerance}% slippage:{" "}
            <span className="text-gray-200 font-mono">
              {formatStroopsToDecimal(minOut, vaultToken.decimals)} {vaultToken.symbol}
            </span>
          </p>
        )}

        {/* Quote source badge + envelope details */}
        {quoteSource && needsSwap && (
          <div className="flex items-center gap-2 flex-wrap">
            <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${
              quoteSource === "router_simulation"
                ? "bg-green-500/20 text-green-400"
                : quoteSource === "fallback_rate"
                  ? "bg-amber-500/20 text-amber-400"
                  : "bg-blue-500/20 text-blue-400"
            }`}>
              {quoteSource === "router_simulation" ? "Simulated" : quoteSource === "fallback_rate" ? "Fallback" : quoteSource}
            </span>

            {/* Quote age */}
            {quoteData && (
              <span className="text-[10px] text-gray-500 flex items-center gap-1">
                <Clock size={10} />
                {quoteAgeSeconds(quoteData.quotedAt)}s ago
                {quoteData.expiresAt && (
                  <span className={`ml-1 ${isExpired ? "text-red-400" : isStale ? "text-orange-400" : "text-gray-500"}`}>
                    · {formatExpiryCountdown(quoteData.expiresAt)}
                  </span>
                )}
              </span>
            )}
            {quoteData?.quoteId && (
              <span className="text-[10px] text-gray-500 font-mono">
                · ID {quoteData.quoteId.slice(0, 8)}
              </span>
            )}
          </div>
        )}

        {quoteData?.expiresAt && needsSwap && (
          <p className="text-[11px] text-gray-500">
            Quote TTL: {quoteData.ttlMs ? `${Math.round(quoteData.ttlMs / 1000)}s` : "30s"} · Expires: {new Date(quoteData.expiresAt).toLocaleTimeString()} · Freeze checked: {new Date(quoteData.freezeCheckedAt).toLocaleTimeString()}
          </p>
        )}

        {quotePath && (
          <p className="text-xs text-gray-500">
            Path: {quotePath}
          </p>
        )}

        {executionBlocked && needsSwap && quoteData && (
          <p className={`text-xs flex items-center gap-1 ${isExpired || (isFallback && !fallbackAck) ? "text-red-400" : "text-amber-400"}`}>
            <AlertTriangle size={10} />
            {executionBlocked}
          </p>
        )}
      </div>

      {/* Slippage tolerance editor */}
      {needsSwap && (
        <div className="bg-white/5 rounded-xl p-3 mb-4">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-1">
              <span className="text-sm text-gray-400">Slippage tolerance</span>
              <button
                type="button"
                onClick={() => setShowSlippageEdit(!showSlippageEdit)}
                className="text-gray-500 hover:text-gray-300"
              >
                <Info size={12} />
              </button>
            </div>
            <span className={`text-sm font-medium ${
              slippageTolerance > 5 ? "text-red-400" : slippageTolerance > 2 ? "text-amber-400" : "text-white"
            }`}>
              {slippageTolerance}%
            </span>
          </div>

          {slippageEdge && (
            <div className={`mb-2 text-xs flex items-start gap-1 ${slippageEdge.level === "high" ? "text-red-400" : slippageEdge.level === "elevated" ? "text-amber-400" : "text-blue-300"}`}>
              <Info size={10} className="mt-0.5 shrink-0" />
              <span>{slippageEdge.msg}</span>
            </div>
          )}

          {showSlippageEdit && (
            <div className="space-y-2">
              <div className="flex gap-2 flex-wrap">
                {[0.1, 0.5, 1, 2, 3, 5].map((val) => (
                  <button
                    key={val}
                    type="button"
                    onClick={() => handleSlippageChange(val)}
                    className={`text-xs px-2 py-1 rounded ${
                      slippageTolerance === val
                        ? "bg-[#6C5DD3] text-white"
                        : "bg-white/10 text-gray-400 hover:bg-white/20"
                    }`}
                  >
                    {val}%
                  </button>
                ))}
              </div>
              <div className="flex items-center gap-2">
                <input
                  type="range"
                  min={MIN_SLIPPAGE}
                  max={MAX_SLIPPAGE}
                  step={0.1}
                  value={slippageTolerance}
                  onChange={(e) => handleSlippageChange(parseFloat(e.target.value))}
                  className="flex-1 accent-[#6C5DD3]"
                />
                <span className="text-xs text-gray-500 w-10 text-right">{slippageTolerance}%</span>
              </div>
              {slippageTolerance >= 5 && (
                <p className="text-xs text-red-400 flex items-center gap-1">
                  <AlertTriangle size={10} />
                  High slippage may result in significant price impact
                </p>
              )}
              <p className="text-[10px] text-gray-500">
                Safe range: {MIN_SLIPPAGE}% – {MAX_SLIPPAGE}%. Higher tolerance means more risk of unfavorable rate. Values &gt;0.15 (15%) are capped at 15% server-side; &lt;0.001 (0.1%) floored at 0.1%.
              </p>
            </div>
          )}
        </div>
      )}

      {/* Deposit route impact warning */}
      {needsSwap && amount && parseFloat(amount) > 0 && (
        <div className="mb-4">
          <DepositRouteMaterialImpactWarning
            amountUsd={0}
            slippageTolerance={slippageTolerance}
            isFallback={isFallback}
            isStale={isStale || isExpired}
          />
        </div>
      )}

      {error && txPhase !== "failure" && (
        <div className="flex items-center gap-2 text-red-400 text-sm mb-4">
          <AlertTriangle className="w-4 h-4 shrink-0" />
          {error}
        </div>
      )}

      <TxStatusTimeline
        steps={TX_PHASE_PIPELINE}
        phase={txPhase}
        errorMessage={txPhase === "failure" ? error : null}
        txHash={txHash}
        failedAtPhase={
          txPhase === "failure"
            ? lastProgressPhase !== "idle"
              ? lastProgressPhase
              : "polling"
            : null
        }
        onRetry={txPhase === "failure" ? retryZap : undefined}
        className="mb-4"
      />

      <button
        type="button"
        onClick={() => void handleZap()}
        disabled={
          !configOk ||
          !amount ||
          status === "loading" ||
          minOut === null ||
          minOut <= 0n ||
          (needsSwap && (!quoteData || isExpired || (isFallback && !fallbackAck)))
        }
        className="w-full py-3 rounded-xl font-semibold text-white bg-gradient-to-r from-blue-500 to-purple-500 hover:from-blue-600 hover:to-purple-600 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
      >
        {status === "loading" ? (
          <>
            <Loader2 className="w-4 h-4 animate-spin" />
            Processing…
          </>
        ) : status === "success" ? (
          "Zap successful"
        ) : needsSwap && isFallback && !fallbackAck ? (
          <>
            <ShieldAlert className="w-4 h-4" />
            Acknowledge fallback to zap
          </>
        ) : needsSwap && isExpired ? (
          <>
            <Clock className="w-4 h-4" />
            Quote expired — Requote
          </>
        ) : needsSwap ? (
          <>
            <Zap className="w-4 h-4" />
            Zap deposit
          </>
        ) : (
          "Deposit"
        )}
      </button>

      <p className="text-xs text-gray-500 text-center mt-3">
        One signed transaction: tokens move into the Zap contract, swap if needed with on-chain
        slippage checks, then shares are minted to your address. If the swap would deliver less than
        the minimum, the whole transaction reverts. Quotes are bound to expiry ({quoteData?.ttlMs ? `${Math.round(quoteData.ttlMs/1000)}s` : "30s"} TTL), asset pair, and freeze state — stale or post-freeze quotes are blocked and require requote.
      </p>
    </div>
  );
}
