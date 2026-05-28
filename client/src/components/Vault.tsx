import { useEffect, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { Landmark, Loader2, AlertCircle, ArrowLeft } from "lucide-react";
import { ZapDepositPanel } from "../features/zap";
import { useWallet } from "../context/useWallet";
import { useVaultOgMeta } from "../hooks/useVaultOgMeta";
import { RecoveryAdvisor } from "./AIAdvisor/RecoveryAdvisor";
import { fetchVaultStats, type VaultStats, formatTvl, validateVaultSlug } from "../lib/vaultData";

/**
 * Injects or updates a <meta> tag in document.head.
 */
function setMetaTag(property: string, content: string): void {
  let el =
    document.querySelector<HTMLMetaElement>(`meta[property="${property}"]`) ??
    document.querySelector<HTMLMetaElement>(`meta[name="${property}"]`);

  if (!el) {
    el = document.createElement("meta");
    el.setAttribute("property", property);
    document.head.appendChild(el);
  }
  el.setAttribute("content", content);
}

export default function Vault() {
  const { walletAddress } = useWallet();
  const { slug } = useParams<{ slug?: string }>();

  const { valid: isSlugValid, normalized: activeSlug } = validateVaultSlug(slug || "usdc");

  const [stats, setStats] = useState<VaultStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(!isSlugValid);

  const meta = useVaultOgMeta(activeSlug);

  // Fetch vault stats
  useEffect(() => {
    if (!isSlugValid) {
      setLoading(false);
      setNotFound(true);
      return;
    }

    let cancelled = false;

    const load = async () => {
      setLoading(true);
      setNotFound(false);

      try {
        const data = await fetchVaultStats(activeSlug);
        if (cancelled) return;
        if (!data) {
          setNotFound(true);
        } else {
          setStats(data);
        }
      } catch {
        if (cancelled) return;
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };

    void load();

    return () => {
      cancelled = true;
    };
  }, [activeSlug, isSlugValid]);

  // Inject OG + Twitter Card meta tags whenever the vault slug changes
  useEffect(() => {
    const prevTitle = document.title;
    document.title = meta.title;

    for (const { property, content } of meta.tags) {
      setMetaTag(property, content);
    }

    return () => {
      document.title = prevTitle;
    };
  }, [meta]);

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] space-y-4">
        <Loader2 size={48} className="text-green-500 animate-spin" />
        <p className="text-gray-400 font-medium">Loading vault details...</p>
      </div>
    );
  }

  if (notFound) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] text-center space-y-6 max-w-md mx-auto px-4">
        <div className="bg-red-500/20 p-6 rounded-full inline-block">
          <AlertCircle size={64} className="text-red-500" />
        </div>
        <h2 className="text-3xl font-bold text-white">Vault Not Found</h2>
        <p className="text-gray-400">
          The vault slug <code className="text-red-400">"{activeSlug}"</code> does not exist in our registry.
        </p>
        <Link
          to="/"
          className="flex items-center gap-2 text-green-500 hover:text-green-400 font-semibold transition-colors"
        >
          <ArrowLeft size={20} />
          Back to Dashboard
        </Link>
      </div>
    );
  }

  const isUnavailable = stats && !stats.live;

  return (
    <div className="flex flex-col items-center min-h-[60vh] text-center space-y-6">
      <div className="bg-green-500/20 p-6 rounded-full inline-block mb-4">
        <Landmark size={64} className="text-green-500" />
      </div>
      
      <div className="space-y-2">
        <h2 className="text-4xl font-extrabold text-white">
          {stats?.name || "Auto-Yield Vault"}
        </h2>
        {isUnavailable && (
          <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-amber-500/20 border border-amber-500/30 text-amber-400 text-xs font-bold uppercase tracking-wider">
            <AlertCircle size={14} />
            Live Data Unavailable
          </div>
        )}
      </div>

      <p className="text-xl text-gray-400 max-w-2xl mx-auto leading-relaxed">
        Smart contracts on Soroban that automatically rebalance your positions into the
        highest-yielding pools across the Stellar ecosystem.
      </p>

      {stats && (
        <div className="grid grid-cols-2 gap-4 w-full max-w-3xl">
          <div className="glass-panel p-6 flex flex-col items-center justify-center space-y-1">
            <span className="text-sm text-gray-500 font-bold uppercase tracking-widest">Current APY</span>
            <span className="text-3xl font-black text-green-400">
              {stats.live ? `${stats.apy.toFixed(2)}%` : "0.00%"}
            </span>
          </div>
          <div className="glass-panel p-6 flex flex-col items-center justify-center space-y-1">
            <span className="text-sm text-gray-500 font-bold uppercase tracking-widest">Total TVL</span>
            <span className="text-3xl font-black text-white">
              {stats.live ? formatTvl(stats.tvl) : "$0"}
            </span>
          </div>
        </div>
      )}

      <div className="max-w-3xl w-full text-left">
        <RecoveryAdvisor vaultId={activeSlug} />
      </div>

      <div className="glass-panel p-8 mt-8 max-w-3xl w-full text-left">
        <ZapDepositPanel walletAddress={walletAddress} />
      </div>
    </div>
  );
}
