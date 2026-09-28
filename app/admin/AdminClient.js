'use client';

import { useState, useEffect, useCallback } from 'react';

/** 与后端约定：提交此值代表「保持原值，不修改」 */
const KEEP = '__KEEP__';

const PROVIDER_PRESETS = [
  { name: 'DeepSeek', baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat' },
  { name: '通义千问', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' },
  { name: '硅基流动', baseUrl: 'https://api.siliconflow.cn/v1', model: 'Qwen/Qwen2.5-7B-Instruct' },
  { name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  { name: '月之暗面', baseUrl: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k' },
];

export default function AdminClient() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [fatal, setFatal] = useState(null);

  const [items, setItems] = useState([]);
  const [access, setAccess] = useState({ enabled: false, passwordSet: false });
  const [encryption, setEncryption] = useState({ enabled: false });
  const [envFallback, setEnvFallback] = useState({});

  // 表单本地态
  const [form, setForm] = useState({});
  const [apiKeyInput, setApiKeyInput] = useState(KEEP);
  const [keyTouched, setKeyTouched] = useState(false);

  // 登录态
  const [authState, setAuthState] = useState({ authEnabled: false, loggedIn: false });
  const [passwordInput, setPasswordInput] = useState('');

  // 新口令设置
  const [newPwd, setNewPwd] = useState('');
  const [newPwdEnabled, setNewPwdEnabled] = useState(null);

  const [toast, setToast] = useState(null);
  const [testResult, setTestResult] = useState(null);

  const flash = (type, text) => {
    setToast({ type, text });
    setTimeout(() => setToast(null), 4200);
  };

  // ---------- 读取 ----------
  const load = useCallback(async () => {
    setLoading(true);
    setFatal(null);
    try {
      const [aRes, sRes] = await Promise.all([
        fetch('/api/auth', { cache: 'no-store' }),
        fetch('/api/settings', { cache: 'no-store' }),
      ]);

      const aJson = await aRes.json().catch(() => ({}));
      setAuthState(aJson);

      if (sRes.status === 401) {
        setFatal('unauthorized');
        return;
      }

      const data = await sRes.json();
      if (!sRes.ok) throw new Error(data.error || '读取配置失败');

      setItems(data.items || []);
      setAccess(data.access || { enabled: false, passwordSet: false });
      setEncryption(data.encryption || { enabled: false });
      setEnvFallback(data.envFallback || {});

      const next = {};
      for (const it of data.items || []) {
        next[it.key] = it.secret ? KEEP : it.value;
      }
      setForm(next);
      setApiKeyInput(KEEP);
      setKeyTouched(false);
      setNewPwdEnabled(data.access?.enabled ?? false);
    } catch (e) {
      setFatal(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // ---------- 登录 ----------
  async function login() {
    try {
      const res = await fetch('/api/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: passwordInput }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '登录失败');
      setPasswordInput('');
      flash('ok', '登录成功');
      await load();
    } catch (e) {
      flash('err', e.message);
    }
  }

  async function logout() {
    await fetch('/api/auth', { method: 'DELETE' });
    flash('ok', '已退出登录');
    await load();
  }

  // ---------- 保存 ----------
  async function save() {
    setSaving(true);
    setTestResult(null);
    try {
      const payload = { ...form };
      // 密钥字段：未改动则提交哨兵，让后端跳过
      payload['llm.api_key'] = keyTouched ? apiKeyInput : KEEP;

      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ settings: payload }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '保存失败');

      flash('ok', `已保存 ${data.written?.length ?? 0} 项，立即生效`);
      await load();
    } catch (e) {
      flash('err', e.message);
    } finally {
      setSaving(false);
    }
  }

  // ---------- 测试 ----------
  async function test() {
    setTesting(true);
    setTestResult(null);
    try {
      const probe = {
        'llm.base_url': form['llm.base_url'],
        'llm.model': form['llm.model'],
        'llm.api_key': keyTouched ? apiKeyInput : KEEP,
      };
      const res = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ probe }),
      });
      const data = await res.json();
      setTestResult(data);
    } catch (e) {
      setTestResult({ ok: false, error: e.message });
    } finally {
      setTesting(false);
    }
  }

  // ---------- 访问口令 ----------
  async function saveAccess() {
    try {
      const body = {};
      if (newPwdEnabled !== null) body.enabled = newPwdEnabled;
      if (newPwd) body.password = newPwd;

      if (Object.keys(body).length === 0) {
        flash('err', '没有需要更新的内容');
        return;
      }

      const res = await fetch('/api/access', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '保存失败');

      // 刚设完口令且启用了，当前会话还没有 Cookie → 引导登录
      if (newPwd && data.authEnabled) {
        flash('ok', '口令已设置。请用新口令登录。');
        setNewPwd('');
        await load();
        return;
      }

      flash('ok', '访问设置已更新');
      setNewPwd('');
      await load();
    } catch (e) {
      flash('err', e.message);
    }
  }

  // ---------- 渲染 ----------
  if (loading) {
    return (
      <div className="admin">
        <p className="empty">正在读取配置…</p>
      </div>
    );
  }

  // 需要登录
  if (fatal === 'unauthorized') {
    return (
      <div className="admin admin-narrow">
        <h1>需要登录</h1>
        <p className="sub">配置中心已启用访问口令保护。</p>
        <div className="loginbox">
          <input
            className="inp"
            type="password"
            placeholder="请输入访问口令"
            value={passwordInput}
            onChange={(e) => setPasswordInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && login()}
            autoFocus
          />
          <button className="save" onClick={login}>登录</button>
        </div>
        {toast && <div className={`toast ${toast.type}`}>{toast.text}</div>}
      </div>
    );
  }

  if (fatal) {
    return (
      <div className="admin admin-narrow">
        <h1>读取失败</h1>
        <pre className="err">{fatal}</pre>
        <p className="sub">请检查 TURSO_DATABASE_URL 与 TURSO_AUTH_TOKEN 是否正确。</p>
      </div>
    );
  }

  const keyItem = items.find((i) => i.key === 'llm.api_key');

  return (
    <div className="admin">
      <header className="admin-head">
        <div>
          <h1>配置中心</h1>
          <p className="sub">
            所有值存放在 Turso 数据库，保存后立即生效，无需重新部署。
          </p>
        </div>
        <div className="head-actions">
          {authState.authEnabled ? (
            <>
              <span className="badge ok">已登录</span>
              <button className="ghost" onClick={logout}>退出</button>
            </>
          ) : (
            <span className="badge warn">未启用口令</span>
          )}
          <a className="ghost" href="/practice">去练习页</a>
          <a className="ghost" href="/dashboard">去看板</a>
        </div>
      </header>

      {/* 加密告警 */}
      {!encryption.enabled && (
        <div className="alert warn">
          <strong>建议配置 SETTINGS_SECRET</strong>
          <p>
            当前未设置该环境变量，API Key 在数据库中<strong>以明文存储</strong>。
            在 Vercel 环境变量里加一个随机字符串（如
            <code>openssl rand -hex 32</code> 的输出）即可自动启用 AES-256-GCM 加密。
          </p>
        </div>
      )}

      {envFallback.llmApiKeyFromEnv && keyItem && !keyItem.configured && (
        <div className="alert info">
          检测到环境变量 <code>LLM_API_KEY</code> 已设置。数据库中的 Key 为空时，
          系统会自动回退使用环境变量的值。
        </div>
      )}

      {/* ============ LLM 配置 ============ */}
      <section className="card-panel">
        <div className="ph">
          <h2>模型配置</h2>
          <span className="ph-sub">决定 AI 说什么、说多长</span>
        </div>

        {/* 服务商预设 */}
        <div className="presets">
          <span className="presets-label">快速填充：</span>
          {PROVIDER_PRESETS.map((p) => (
            <button
              key={p.name}
              className="chip"
              onClick={() =>
                setForm((f) => ({
                  ...f,
                  'llm.base_url': p.baseUrl,
                  'llm.model': p.model,
                  'llm.provider_name': p.name,
                }))
              }
            >
              {p.name}
            </button>
          ))}
        </div>

        <div className="fields">
          <label className="field">
            <span className="flabel">服务商显示名</span>
            <input
              className="inp"
              value={form['llm.provider_name'] ?? ''}
              onChange={(e) => setForm((f) => ({ ...f, 'llm.provider_name': e.target.value }))}
              placeholder="DeepSeek"
            />
          </label>

          <label className="field">
            <span className="flabel">
              API 地址
              <em>以 /v1 结尾（若服务商要求）</em>
            </span>
            <input
              className="inp"
              value={form['llm.base_url'] ?? ''}
              onChange={(e) => setForm((f) => ({ ...f, 'llm.base_url': e.target.value }))}
              placeholder="https://api.deepseek.com"
            />
          </label>

          <label className="field">
            <span className="flabel">模型名</span>
            <input
              className="inp"
              value={form['llm.model'] ?? ''}
              onChange={(e) => setForm((f) => ({ ...f, 'llm.model': e.target.value }))}
              placeholder="deepseek-chat"
            />
          </label>

          {/* API Key —— 掩码 + 保持原值 */}
          <label className="field full">
            <span className="flabel">
              API Key
              {keyItem?.configured && !keyTouched && (
                <em className="ok">已配置 · {keyItem.value}</em>
              )}
            </span>
            <div className="keyrow">
              <input
                className="inp"
                type="password"
                value={keyTouched ? apiKeyInput : ''}
                onChange={(e) => {
                  setApiKeyInput(e.target.value);
                  setKeyTouched(true);
                }}
                placeholder={
                  keyItem?.configured
                    ? '留空则保持原值不变'
                    : 'sk-...（必填）'
                }
              />
              {keyTouched && (
                <button
                  className="ghost"
                  onClick={() => {
                    setKeyTouched(false);
                    setApiKeyInput(KEEP);
                  }}
                >
                  取消修改
                </button>
              )}
              {keyItem?.configured && keyTouched && (
                <button
                  className="ghost danger"
                  onClick={() => {
                    setKeyTouched(true);
                    setApiKeyInput('');
                    flash('ok', '已标记为清除，点击「保存」后生效');
                  }}
                >
                  清除
                </button>
              )}
            </div>
            <span className="fhelp">
              出于安全考虑，已保存的 Key 不会回显明文。输入新值即覆盖，留空即不变。
            </span>
          </label>

          <label className="field">
            <span className="flabel">
              温度
              <em>0 稳定 · 2 发散</em>
            </span>
            <input
              className="inp"
              type="number"
              step="0.1"
              min="0"
              max="2"
              value={form['llm.temperature'] ?? ''}
              onChange={(e) => setForm((f) => ({ ...f, 'llm.temperature': e.target.value }))}
            />
          </label>

          <label className="field">
            <span className="flabel">
              单次最大输出 tokens
              <em>太大会拖慢语音合成</em>
            </span>
            <input
              className="inp"
              type="number"
              min="1"
              max="8192"
              value={form['llm.max_tokens'] ?? ''}
              onChange={(e) => setForm((f) => ({ ...f, 'llm.max_tokens': e.target.value }))}
            />
          </label>
        </div>

        <div className="actions">
          <button className="save" onClick={save} disabled={saving}>
            {saving ? '保存中…' : '保存配置'}
          </button>
          <button className="ghost" onClick={test} disabled={testing}>
            {testing ? '测试中…' : '测试连接'}
          </button>
        </div>

        {testResult && (
          <div className={`alert ${testResult.ok ? 'ok' : 'err'}`}>
            {testResult.ok ? (
              <>
                <strong>连接成功</strong>（{testResult.ms} ms）
                <p>
                  模型：<code>{testResult.model}</code>
                  {testResult.usage ? ` · 消耗 ${testResult.usage.total_tokens ?? '?'} tokens` : ''}
                </p>
                {testResult.sample && (
                  <p className="sample">返回内容：「{testResult.sample}」</p>
                )}
              </>
            ) : (
              <>
                <strong>连接失败</strong>（{testResult.ms} ms）
                <p className="mono">{testResult.error}</p>
              </>
            )}
          </div>
        )}
      </section>

      {/* ============ 访问口令 ============ */}
      <section className="card-panel">
        <div className="ph">
          <h2>访问保护</h2>
          <span className="ph-sub">
            防止别人白嫖你的 API 额度
          </span>
        </div>

        <div className="alert info compact">
          启用后，访问练习页和对话接口都需要先输入口令。
          <strong>首次使用请务必设置</strong>。
        </div>

        <div className="fields">
          <label className="field">
            <span className="flabel">启用访问口令</span>
            <div className="switchrow">
              <button
                className={`switch ${newPwdEnabled ? 'on' : ''}`}
                onClick={() => setNewPwdEnabled((v) => !v)}
              >
                <span className="knob" />
              </button>
              <span className="switchlabel">
                {newPwdEnabled ? '已启用' : '未启用（任何人可访问）'}
              </span>
            </div>
          </label>

          <label className="field full">
            <span className="flabel">
              {access.passwordSet ? '修改访问口令' : '设置访问口令'}
              {access.passwordSet && <em className="ok">已设置</em>}
            </span>
            <input
              className="inp"
              type="password"
              value={newPwd}
              onChange={(e) => setNewPwd(e.target.value)}
              placeholder={access.passwordSet ? '输入新口令以覆盖' : '建议 8 位以上'}
            />
            <span className="fhelp">
              口令以 scrypt 加盐哈希存储，数据库泄露也无法还原。
            </span>
          </label>
        </div>

        <div className="actions">
          <button className="save" onClick={saveAccess}>更新访问设置</button>
          {access.passwordSet && (
            <button
              className="ghost danger"
              onClick={async () => {
                if (!window.confirm('确定清除访问口令？清除后任何人可访问你的接口和 API 额度。')) return;
                setNewPwd('');
                setNewPwdEnabled(false);
                await saveAccess();
              }}
            >
              清除口令
            </button>
          )}
        </div>
      </section>

      {/* ============ 环境变量说明 ============ */}
      <section className="card-panel muted-panel">
        <div className="ph">
          <h2>仍需环境变量保存的项</h2>
          <span className="ph-sub">自举依赖，无法存进数据库</span>
        </div>
        <table className="envtable">
          <tbody>
            <tr>
              <td><code>TURSO_DATABASE_URL</code></td>
              <td>{envFallback.tursoUrlFromEnv ? <span className="badge ok">已配置</span> : <span className="badge err">缺失</span>}</td>
              <td>数据库地址。必须先有它才能读到后续配置。</td>
            </tr>
            <tr>
              <td><code>TURSO_AUTH_TOKEN</code></td>
              <td><span className="badge ok">已配置</span></td>
              <td>数据库认证令牌。</td>
            </tr>
            <tr>
              <td><code>SETTINGS_SECRET</code></td>
              <td>{encryption.enabled ? <span className="badge ok">已配置</span> : <span className="badge warn">未配置</span>}</td>
              <td>用于加密 API Key 与签发登录 Cookie。强烈建议配置。</td>
            </tr>
          </tbody>
        </table>
      </section>

      <p className="foot">
        <a href="/practice">→ 练习页</a>
        <a href="/dashboard">→ 学习看板</a>
      </p>

      {toast && <div className={`toast ${toast.type}`}>{toast.text}</div>}
    </div>
  );
}
