/**
 * dsh-token-billing — Browser half (dsh.client bundle).
 *
 * 计费读数行：注册在 conversation.composer.dock（composer 卡片下方的
 * 环境读数带，与官方统计行同族），处于布局流内，随视口自适应，
 * 不遮挡输入区。每 2.5 秒轮询 Host 的 /api/token-billing JSON 路由。
 */
window.__ModuleLoader__.load({
	id: "dsh-token-billing",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		let React = require("react");

		// 视觉对齐官方 StatsLine（composer.dock = stats-line family）：
		// 12/20 三级文本、内容列宽、居中、超长省略。
		const CSS_TEXT = `
.dsh-billing-row {
  display: block;
  text-align: center;
  max-width: var(--dsh-chat-content-width);
  width: 100%;
  margin: 0 auto;
  box-sizing: border-box;
  padding: 4px calc(var(--dsh-composer-side-clearance, 0px) + 16px) 0px;
  font-size: 12px;
  line-height: 20px;
  color: var(--dsw-alias-label-tertiary);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.dsh-billing-row .sep { color: var(--dsw-alias-separator-primary); margin: 0 10px; }
.dsh-billing-row .cost { color: var(--dsw-alias-label-secondary); font-weight: 500; }
`;
		const CSS_TAG = "dsh-token-billing";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(CSS_TAG) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-token-billing";
			tag.dataset.pluginCss = CSS_TAG;
			tag.textContent = CSS_TEXT;
			document.head.appendChild(tag);
		}

		function fmtTokens(n) {
			const scaled = (v) => v >= 100 ? String(Math.round(v)) : String(Math.round(v * 10) / 10);
			if (n < 1000) return String(n);
			if (n < 1e6) return `${scaled(n / 1e3)}K`;
			return `${scaled(n / 1e6)}M`;
		}
		function fmtCost(c) {
			if (c >= 100) return c.toFixed(0);
			if (c >= 1) return c.toFixed(2);
			if (c >= 0.01) return c.toFixed(3);
			return c.toFixed(4);
		}
		function buildTooltip(state, hasSession) {
			const t = state.totals;
			const g = state.global;
			const p = state.prices;
			const lines = [];
			const scope = hasSession ? "当前会话" : "全部会话";
			const cost = hasSession ? t.cost : g.totals.cost;
			lines.push(`${scope} · ${state.period === "peak" ? "高峰时段" : "空闲时段"} · 费用 ¥${fmtCost(cost)}`);
			const miss = hasSession ? t.inputTokens + t.cacheWriteTokens : g.totals.inputTokens + g.totals.cacheWriteTokens;
			const hit = hasSession ? t.cacheReadTokens : g.totals.cacheReadTokens;
			const out = hasSession ? t.outputTokens : g.totals.outputTokens;
			const calls = hasSession ? t.calls : g.totals.calls;
			lines.push(`调用 ${calls} 次 · 输入(未命中) ${fmtTokens(miss)} · 缓存命中 ${fmtTokens(hit)} · 输出 ${fmtTokens(out)}`);
			const names = { flash: "deepseek-v4-flash", pro: "deepseek-v4-pro", other: "其他模型(未定价)" };
			const models = hasSession ? state.byModel : g.byModel;
			for (const key of ["flash", "pro", "other"]) {
				const bm = models[key];
				if (!bm) continue;
				lines.push(`${names[key]}: ${bm.calls} 次 · ¥${fmtCost(bm.cost)}`);
			}
			const sw = state.sessionWorkspace;
			if (sw) {
				lines.push("");
				lines.push(`工作区 ${sw.title}: 调用 ${sw.totals.calls} 次 · 费用 ¥${fmtCost(sw.totals.cost)} · 可见会话 ${sw.sessionCount} 个`);
				if (sw.path) lines.push(`  (${sw.path})`);
				if (state.workspaces && state.workspaces.length > 1) {
					lines.push("其他工作区:");
					for (const w of state.workspaces) {
						if (w.key === sw.key) continue;
						lines.push(`  ${w.title}: ¥${fmtCost(w.totals.cost)} · 可见会话 ${w.sessionCount} 个`);
					}
				}
			}
			if (g.sessionCount > 0) {
				lines.push("");
				lines.push(`全部会话 (${g.sessionCount} 个): 调用 ${g.totals.calls} 次 · 费用 ¥${fmtCost(g.totals.cost)}`);
			}
			lines.push("");
			lines.push("单价（元 / 百万 tokens，高峰 / 空闲）:");
			lines.push(`deepseek-v4-flash  命中 ${p.flash.hit.peak}/${p.flash.hit["off-peak"]} · 未命中 ${p.flash.miss.peak}/${p.flash.miss["off-peak"]} · 输出 ${p.flash.output.peak}/${p.flash.output["off-peak"]}`);
			lines.push(`deepseek-v4-pro    命中 ${p.pro.hit.peak}/${p.pro.hit["off-peak"]} · 未命中 ${p.pro.miss.peak}/${p.pro.miss["off-peak"]} · 输出 ${p.pro.output.peak}/${p.pro.output["off-peak"]}`);
			lines.push("高峰时段: 北京时间 9:00-12:00、14:00-18:00（其余为空闲时段）");
			lines.push(`来源: ${state.source}`);
			return lines.join("\n");
		}

		function BillingDockRow(props) {
			const useSessions = props.useSessions;
			const current = useSessions ? useSessions((s) => (s ? s.current : undefined)) : undefined;
			const sessionId = current || null;
			const [state, setState] = React.useState(null);
			React.useEffect(() => {
				let alive = true;
				const refresh = () => {
					const q = sessionId ? "?session=" + encodeURIComponent(sessionId) : "";
					fetch("/api/token-billing" + q, { cache: "no-store" })
						.then((r) => r.json())
						.then((res) => {
							if (alive && res && res.ok) setState(res);
						})
						.catch(() => {});
				};
				refresh();
				const timer = window.setInterval(refresh, 2500);
				return () => { alive = false; window.clearInterval(timer); };
			}, [sessionId]);
			if (!state) return null;
			const hasSession = !!sessionId;
			const g = state.global;
			// 第二项跟随当前会话的归属工作区（标签用工作区名）；
			// 会话未归属到工作区实体时回退全局汇总。
			const sw = state.sessionWorkspace;
			const groups = [];
			if (hasSession) {
				groups.push(["本会话 ", React.createElement("span", { key: "c0", className: "cost" }, `¥${fmtCost(state.totals.cost)}`)]);
				groups.push([`${sw ? sw.title : "全部会话"} `, React.createElement("span", { key: "c1", className: "cost" }, `¥${fmtCost(sw ? sw.totals.cost : g.totals.cost)}`)]);
			} else {
				groups.push(["全部会话 ", React.createElement("span", { key: "c0", className: "cost" }, `¥${fmtCost(g.totals.cost)}`)]);
			}
			groups.push([state.period === "peak" ? "高峰时段" : "空闲时段"]);
			const kids = [];
			groups.forEach((group, i) => {
				if (i > 0) {
					kids.push(React.createElement("span", { key: "sep" + i, className: "sep", "aria-hidden": "true" }, "|"));
					kids.push(" ");
				}
				kids.push(React.createElement("span", { key: "g" + i }, group));
			});
			return React.createElement("div", { className: "dsh-billing-row", title: buildTooltip(state, hasSession) }, kids);
		}

		function apply(ctx) {
			// 官方模式：slots 通过 ctx.slots 访问；slots.inject 等待声明后注册
			ctx.slots.inject("conversation.composer.dock", () => ctx.slots.register(
				{ name: "conversation.composer.dock", id: "token-billing", order: 100 },
				(props) => React.createElement(BillingDockRow, { useSessions: props.useSessions }),
			));
		}

		exports.inject = ["slots"];
		exports.apply = apply;
		return module.exports;
	}
});
