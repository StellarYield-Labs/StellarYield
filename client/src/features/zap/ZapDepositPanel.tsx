import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, Zap, Loader2, AlertTriangle, RefreshCw, Clock, Info, ShieldAlert } from "lucide-react";
import TxStatusTimeline from "../../components/transaction/TxStatusTimeline";
import { zapDeposit } from "../../services/soroban";
import type { TxPhase } from "../../services/transactionPhase";
import { TX_PHASE_PIPELINE } from "../../services/transactionPhase";
import { fetchSwapQuote, verifyZapQuote, isQuoteExpired, isQuoteStale } from "./fetchSwapQuote";
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

function expiresInSeconds(expiresAt?: string): number | null {
  if (!expiresAt) return null;
  const exp = new Date(expiresAt).getTime();
  if (isNaN(exp)) return null;
  return Math.max(0, Math.floor((exp - Date.now()) / 1000));
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
  const [fallbackAcknowledged, setFallbackAcknowledged] = useState(false);
  const [ticks, setTicks] = useState(0);

  // Ticking for expiry countdown
  useEffect(() => {
    const id = setInterval(() => setTicks((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, []);
  void ticks;

  const needsSwap = inputAsset?.contractId !== vaultToken.contractId;

  const refreshQuote = useCallback(async () => {
    if (!inputAsset || !amount || !vaultToken.contractId) {
      setExpectedOut(null);
      setQuotePath("");
      setQuoteData(null);
      setFallbackAcknowledged(false);
      setVerifyError("");
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
        setFallbackAcknowledged(false);
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
        setFallbackAcknowledged(false);
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
    if (quoteData?.minAmountOutStroops) {
      try {
        return BigInt(quoteData.minAmountOutStroops);
      } catch {
        // fallback to computed
      }
    }
    if (expectedOut === null || expectedOut <= 0n) return null;
    return minAmountAfterSlippage(expectedOut, slippageTolerance);
  }, [quoteData, expectedOut, slippageTolerance]);

  const isExpired = useMemo(() => {
    if (!quoteData) return false;
    return isQuoteExpired(quoteData);
  }, [quoteData, ticks]);

  const isStale = useMemo(() => {
    if (!quoteData) return false;
    if (isExpired) return true;
    if (isQuoteStale(quoteData)) return true;
    return quoteAgeSeconds(quoteData.quotedAt) > STALE_QUOTE_AGE_MS / 1000;
  }, [quoteData, isExpired, ticks]);

  const isFallback = useMemo(() => {
    if (!quoteData) return false;
    return quoteData.isFallback || quoteData.source === FALLBACK_SOURCE;
  }, [quoteData]);

  const hasSlippageChanged = useMemo(() => {
    if (!quoteData || quoteData.slippageTolerance === undefined) return false;
    const quoteSlipPct = quoteData.slippageTolerance * 100;
    return Math.abs(quoteSlipPct - slippageTolerance) > 0.0001;
  }, [quoteData, slippageTolerance]);

  const hasAssetMismatch = useMemo(() => {
    if (!quoteData) return false;
    if (!inputAsset || !vaultToken.contractId) return false;
    // Backward compat: older quotes may lack binding fields
    if (!quoteData.inputTokenContract || !quoteData.vaultTokenContract) return false;
    return (
      quoteData.inputTokenContract !== inputAsset.contractId ||
      quoteData.vaultTokenContract !== vaultToken.contractId
    );
  }, [quoteData, inputAsset, vaultToken]);

  const expiresIn = useMemo(() => {
    if (!quoteData?.expiresAt) return null;
    return expiresInSeconds(quoteData.expiresAt);
  }, [quoteData, ticks]);

  const requiresRequote = isExpired || isStale || hasSlippageChanged || hasAssetMismatch;

  const canExecuteFallback = !isFallback || fallbackAcknowledged;

  const isQuoteValidForExecution = useMemo(() => {
    if (!needsSwap) return true;
    if (!quoteData) return false;
    if (requiresRequote) return false;
    if (!canExecuteFallback) return false;
    if (minOut === null || minOut <= 0n) return false;
    return true;
  }, [needsSwap, quoteData, requiresRequote, canExecuteFallback, minOut]);

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

    // Safety envelope: verify quote before execution if swap needed
    if (needsSwap && quoteData) {
      if (isExpired) {
        setError("Quote has expired. Please request a fresh quote.");
        setVerifyError("QUOTE_EXPIRED");
        return;
      }
      if (isStale) {
        setError("Quote is stale. Please refresh for current rates.");
        setVerifyError("QUOTE_STALE");
        return;
      }
      if (hasSlippageChanged) {
        setError("Slippage tolerance changed since quote. Please requote.");
        setVerifyError("SLIPPAGE_CHANGED");
        return;
      }
      if (hasAssetMismatch) {
        setError("Asset pair changed since quote. Please requote.");
        setVerifyError("ASSET_MISMATCH");
        return;
      }
      if (isFallback && !fallbackAcknowledged) {
        setError("Fallback quote requires explicit confirmation. Please acknowledge the risk.");
        setVerifyError("FALLBACK_REQUIRES_CONFIRMATION");
        return;
      }

      // Remote verification for freeze & expiry & fallback semantics
      try {
        const verify = await verifyZapQuote({
          quoteId: quoteData.quoteId,
          inputTokenContract: inputAsset.contractId,
          vaultTokenContract: vaultToken.contractId,
          amountInStroops: amountIn.toString(),
          slippageTolerance: slippageTolerance / 100,
          allowFallback: fallbackAcknowledged,
          protocol: quoteData.protocol,
          quotedAt: quoteData.quotedAt,
          expiresAt: quoteData.expiresAt,
          expectedAmountOutStroops: quoteData.expectedAmountOutStroops,
          minAmountOutStroops: quoteData.minAmountOutStroops,
          source: quoteData.source,
          signature: quoteData.signature,
        });
        if (!verify.valid) {
          setError(verify.reason || "Quote verification failed. Please requote.");
          setVerifyError(verify.code || "VERIFY_FAILED");
          if (verify.code === "QUOTE_EXPIRED" || verify.code === "QUOTE_STALE" || verify.code === "FREEZE_INVALIDATED" || verify.code === "ASSET_MISMATCH" || verify.code === "FALLBACK_REQUIRES_CONFIRMATION") {
            // Force requote
          }
          return;
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : "Quote verification failed");
        setVerifyError("VERIFY_FAILED");
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
    isStale,
    hasSlippageChanged,
    hasAssetMismatch,
    isFallback,
    fallbackAcknowledged,
    slippageTolerance,
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
          title="Refresh quote"
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

      {/* Quote ID / expiry header */}
      {quoteData && needsSwap && (
        <div className="mb-3 flex items-center justify-between text-[11px] text-gray-500">
          <span className="font-mono truncate max-w-[60%]">
            Quote {(quoteData.quoteId ?? "test-id").slice(0, 8)}… {quoteData.protocol ? `· ${quoteData.protocol}` : ""}
          </span>
          <span className={`flex items-center gap-1 ${expiresIn !== null && expiresIn <= 5 ? "text-orange-400" : ""}`}>
            <Clock size={10} />
            {expiresIn !== null ? (expiresIn > 0 ? `${expiresIn}s left` : "expired") : `${quoteAgeSeconds(quoteData.quotedAt)}s ago`}
          </span>
        </div>
      )}

      {/* Fallback quote warning with acknowledgment */}
      {isFallback && needsSwap && (
        <div className="mb-4 flex flex-col gap-2 text-amber-200/90 text-sm bg-amber-500/10 border border-amber-500/30 rounded-lg p-3">
          <div className="flex items-start gap-2">
            <Info className="w-4 h-4 shrink-0 mt-0.5 text-amber-400" />
            <div className="flex-1">
              <p className="font-medium text-amber-300">Fallback quote active</p>
              <p className="text-xs text-amber-200/70">
                Router simulation unavailable — not router-simulated. Using estimated rate (TVL-based). Actual output may differ significantly. Do not treat as executable market price.
              </p>
            </div>
          </div>
          <label className="flex items-center gap-2 text-xs bg-amber-500/10 border border-amber-500/20 rounded px-2 py-1.5 cursor-pointer">
            <input
              type="checkbox"
              checked={fallbackAcknowledged}
              onChange={(e) => setFallbackAcknowledged(e.target.checked)}
              className="accent-amber-500"
            />
            <span className="text-amber-200">I understand this is a fallback estimate and accept the risk</span>
          </label>
          {!fallbackAcknowledged && (
            <p className="text-xs text-amber-300/80">Explicit confirmation required to execute with fallback quote.</p>
          )}
        </div>
      )}

      {/* Stale / Expired quote warning */}
      {(isExpired || isStale) && needsSwap && quoteData && !quoteLoading && (
        <div className="mb-4 flex items-start gap-2 text-orange-200/90 text-sm bg-orange-500/10 border border-orange-500/30 rounded-lg p-3">
          <Clock className="w-4 h-4 shrink-0 mt-0.5 text-orange-400" />
          <div className="flex-1">
            <p className="font-medium text-orange-300">{isExpired ? "Quote expired" : "Stale quote"}</p>
            <p className="text-xs text-orange-200/70">
              {isExpired
                ? `Quote expired at ${new Date(quoteData.expiresAt).toLocaleTimeString()}. A fresh quote is required before execution.`
                : `Quote is over ${Math.floor((quoteData.expiresInMs ?? STALE_QUOTE_AGE_MS)/1000)} seconds old. Market conditions may have shifted.`}
            </p>
            <button
              type="button"
              onClick={() => void refreshQuote()}
              className="mt-2 text-xs px-3 py-1 rounded bg-orange-500/20 text-orange-300 hover:bg-orange-500/30"
            >
              Requote now
            </button>
          </div>
        </div>
      )}

      {/* Slippage changed warning */}
      {hasSlippageChanged && needsSwap && quoteData && (
        <div className="mb-4 flex items-start gap-2 text-yellow-200/90 text-sm bg-yellow-500/10 border border-yellow-500/30 rounded-lg p-3">
          <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5 text-yellow-400" />
          <div className="flex-1">
            <p className="font-medium text-yellow-300">Slippage changed — requote required</p>
            <p className="text-xs text-yellow-200/70">
              Quote was generated with {((quoteData.slippageTolerance ?? quoteData.slippageApplied) * 100).toFixed(2)}% tolerance, now {slippageTolerance}%. Please refresh quote to bind new tolerance.
            </p>
            <button
              type="button"
              onClick={() => void refreshQuote()}
              className="mt-2 text-xs px-3 py-1 rounded bg-yellow-500/20 text-yellow-300 hover:bg-yellow-500/30"
            >
              Requote with {slippageTolerance}%
            </button>
          </div>
        </div>
      )}

      {/* Asset mismatch warning */}
      {hasAssetMismatch && needsSwap && (
        <div className="mb-4 flex items-start gap-2 text-red-200/90 text-sm bg-red-500/10 border border-red-500/30 rounded-lg p-3">
          <ShieldAlert className="w-4 h-4 shrink-0 mt-0.5 text-red-400" />
          <div className="flex-1">
            <p className="font-medium text-red-300">Asset pair changed — requote required</p>
            <p className="text-xs text-red-200/70">
              Quote was for {(quoteData?.inputTokenContract ?? "?").slice(0,6)}→{(quoteData?.vaultTokenContract ?? "?").slice(0,6)}, now {(inputAsset?.contractId ?? "?").slice(0,6)}→{(vaultToken.contractId ?? "?").slice(0,6)}. Execution would use wrong assumptions.
            </p>
            <button
              type="button"
              onClick={() => void refreshQuote()}
              className="mt-2 text-xs px-3 py-1 rounded bg-red-500/20 text-red-300 hover:bg-red-500/30"
            >
              Requote for new pair
            </button>
          </div>
        </div>
      )}

      {/* Verify error (freeze, etc) */}
      {verifyError && (
        <div className="mb-4 flex items-start gap-2 text-red-200/90 text-sm bg-red-500/10 border border-red-500/30 rounded-lg p-3">
          <ShieldAlert className="w-4 h-4 shrink-0 mt-0.5 text-red-400" />
          <div className="flex-1">
            <p className="font-medium text-red-300">Execution blocked: {verifyError}</p>
            <p className="text-xs text-red-200/70">
              {verifyError === "FREEZE_INVALIDATED" && "A protocol freeze occurred after this quote was generated. Please requote after freeze review."}
              {verifyError === "PROTOCOL_FROZEN" && "Protocol is currently frozen. Execution is disabled."}
              {verifyError === "FALLBACK_REQUIRES_CONFIRMATION" && "Fallback quote requires explicit confirmation before execution."}
              {verifyError === "QUOTE_EXPIRED" && "Quote has expired. Fresh pricing required."}
              {verifyError === "ASSET_MISMATCH" && "Quote asset pair does not match current selection."}
              {verifyError === "AMOUNT_MISMATCH" && "Quote amount differs from current input amount."}
              {verifyError === "SLIPPAGE_CHANGED" && "Slippage tolerance changed; requote needed."}
              {!["FREEZE_INVALIDATED","PROTOCOL_FROZEN","FALLBACK_REQUIRES_CONFIRMATION","QUOTE_EXPIRED","ASSET_MISMATCH","AMOUNT_MISMATCH","SLIPPAGE_CHANGED"].includes(verifyError) && "Please request a fresh quote before trying again."}
            </p>
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
            {quoteData?.slippageApplied !== undefined && (
              <span className="text-[11px] text-gray-500 ml-1">
                (quote slippage {(quoteData.slippageApplied*100).toFixed(2)}%)
              </span>
            )}
          </p>
        )}

        {/* Quote source badge */}
        {quoteSource && needsSwap && (
          <div className="flex items-center gap-2">
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
                {quoteAgeSeconds(quoteData.quotedAt)}s ago {expiresIn !== null && `· ${expiresIn}s ttl`}
              </span>
            )}
            {isFallback && (
              <span className="text-[10px] text-amber-400 font-medium">fallback</span>
            )}
          </div>
        )}

        {quotePath && (
          <p className="text-xs text-gray-500">
            Path: {quotePath}
          </p>
        )}
        {quoteData?.tvlAtQuote && (
          <p className="text-[11px] text-gray-500">
            TVL at quote: {quoteData.tvlAtQuote} · freeze: {quoteData.freezeStateAtQuote.isFrozen ? "frozen" : "ok"}
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
                Safe range: {MIN_SLIPPAGE}% – {MAX_SLIPPAGE}%. Higher tolerance means more risk of unfavorable rate.
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
          (needsSwap && !isQuoteValidForExecution)
        }
        title={!isQuoteValidForExecution && needsSwap ? "Quote requires requote or confirmation before execution" : undefined}
        className="w-full py-3 rounded-xl font-semibold text-white bg-gradient-to-r from-blue-500 to-purple-500 hover:from-blue-600 hover:to-purple-600 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
      >
        {status === "loading" ? (
          <>
            <Loader2 className="w-4 h-4 animate-spin" />
            Processing…
          </>
        ) : status === "success" ? (
          "Zap successful"
        ) : needsSwap ? (
          <>
            <Zap className="w-4 h-4" />
            {requiresRequote ? "Requote required" : !canExecuteFallback ? "Confirm fallback to zap" : "Zap deposit"}
          </>
        ) : (
          "Deposit"
        )}
      </button>

      {needsSwap && requiresRequote && (
        <button
          type="button"
          onClick={() => void refreshQuote()}
          className="w-full mt-2 py-2 rounded-xl text-sm font-medium bg-white/10 hover:bg-white/20 text-white flex items-center justify-center gap-2"
        >
          <RefreshCw className="w-4 h-4" />
          Refresh quote
        </button>
      )}

      <p className="text-xs text-gray-500 text-center mt-3">
        One signed transaction: tokens move into the Zap contract, swap if needed with on-chain
        slippage checks, then shares are minted to your address. If the swap would deliver less than
        the minimum, the whole transaction reverts. Quotes expire in {Math.floor((quoteData?.expiresInMs ?? 30000)/1000)}s and are bound to route, slippage, TVL, and freeze state.
      </p>
    </div>
  );
}
