import { useState } from 'react';
import { ArrowRight, Check, Shield } from 'lucide-react';

import { api, readApiJson } from '@/shared/api';
import { AgentDiscoveryPanel } from '@/modules/agent-discovery';
import { RemoteAccessTab } from '@/modules/remote-access';
import { ProviderLoginModal } from '@/modules/provider-auth';
import type { LLMProvider } from '@/shared/types';

/** Auth's ProtectedRoute gives a fresh desktop owner agent discovery and optional remote credentials. */
export function DesktopSetup({ onComplete }: { onComplete: () => Promise<void> }) {
  // The wizard retains its current step and unsaved remote credential fields until the owner finishes.
  const [step, setStep] = useState(0);
  // An installed but signed-out agent can reuse the normal provider login flow during setup.
  const [loginProvider, setLoginProvider] = useState<LLMProvider | null>(null);
  // Keep the optional remote account name until its enrollment completes.
  const [username, setUsername] = useState('');
  // Hold the password only while submitting the optional remote account.
  const [password, setPassword] = useState('');
  // A newly issued OTP seed is shown once for enrollment and never persisted in browser storage.
  const [enrollment, setEnrollment] = useState<{ secret: string; otpAuthUrl: string } | null>(null);
  // Prevent account creation and wizard completion from overlapping.
  const [busy, setBusy] = useState(false);
  // Keep a failed setup operation visible without discarding the current step.
  const [error, setError] = useState('');
  return <main className="h-dvh overflow-y-auto bg-background text-foreground"><div className="mx-auto max-w-3xl space-y-6 px-4 py-8 sm:py-12">
    <header className="flex items-center gap-3"><img src="/nexagent-mark.svg" alt="" className="h-12 w-12"/><div><h1 className="text-2xl font-semibold">Nexagent</h1><p className="text-sm text-muted-foreground">本机管理员已创建 · 操作系统身份保护</p></div></header>
    <nav aria-label="首次设置" className="flex flex-wrap gap-4 border-b border-border pb-3 text-sm">{['本机 Agent', '远程管理员', '远程访问'].map((label, index) => <span key={label} aria-current={step === index ? 'step' : undefined} className={step === index ? 'font-semibold' : 'text-muted-foreground'}>{index < step ? <Check className="mr-1 inline" size={14}/> : `${index + 1}. `}{label}</span>)}</nav>
    {step === 0 && <AgentDiscoveryPanel onLogin={setLoginProvider}/>}
    {loginProvider && <ProviderLoginModal isOpen provider={loginProvider} onClose={() => setLoginProvider(null)} onComplete={() => { void api.providers.rescan().then(() => window.dispatchEvent(new Event('nexagent:discovery-updated'))); }}/>} 
    {step === 1 && <section className="space-y-4"><h2 className="flex items-center gap-2 text-lg font-semibold"><Shield size={20}/>远程管理员</h2>{enrollment ? <div className="space-y-3"><p>账号已创建。请将此密钥添加到验证器。</p><code className="block break-all rounded-md border border-border p-3">{enrollment.secret}</code><a href={enrollment.otpAuthUrl} className="text-primary underline">添加到验证器</a></div> : <form className="space-y-3" onSubmit={event => {
      event.preventDefault(); setBusy(true); setError('');
      void api.auth.configureRemoteAccount(username, password).then(readApiJson<{ secret: string; otpAuthUrl: string }>).then(value => { setEnrollment(value); setPassword(''); }).catch(() => setError('创建失败：账号名需 3 至 64 字符，密码至少 16 字符')).finally(() => setBusy(false));
    }}><label className="block text-sm">账号<input required minLength={3} maxLength={64} autoComplete="username" value={username} onChange={event => setUsername(event.target.value)} className="mt-1 block w-full rounded-md border border-border bg-background p-2"/></label><label className="block text-sm">密码<input required type="password" minLength={16} autoComplete="new-password" value={password} onChange={event => setPassword(event.target.value)} className="mt-1 block w-full rounded-md border border-border bg-background p-2"/></label><button disabled={busy} className="rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground">创建远程账号</button></form>}</section>}
    {step === 2 && <RemoteAccessTab/>}
    {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
    <footer className="flex justify-end border-t border-border pt-4"><button disabled={busy} className="flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground" onClick={() => {
      if (step < 2) { setStep(step + 1); return; }
      setBusy(true); void api.user.completeOnboarding().then(readApiJson).then(onComplete).catch(() => setError('无法完成设置')).finally(() => setBusy(false));
    }}>{step === 2 ? '进入工作区' : step === 1 && !enrollment ? '稍后设置' : '继续'}<ArrowRight size={16}/></button></footer>
  </div></main>;
}
