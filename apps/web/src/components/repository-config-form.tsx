'use client';
import { type RepositoryConfig, lines } from '../lib/repository';

export const inputClass = 'mt-1 w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm';
export function ConfigForm({ config, onChange }: { config: RepositoryConfig; onChange: (value: RepositoryConfig) => void }) {
  const arrays = [
    ['dependencyFiles', '依赖锁文件（每行一项）'], ['allowedPaths', '允许修改范围'], ['protectedPaths', '保护文件范围'],
    ['staticCheck', '静态检查命令'], ['failToPass', '定向测试命令'], ['passToPass', '回归检查命令'], ['acceptanceCriteria', '验收标准'],
  ] as const;
  return <div className="grid gap-4 md:grid-cols-2">
    <label>默认交付方式<select className={inputClass} value={config.defaultDelivery || 'patch'} onChange={(e) => onChange({ ...config, defaultDelivery: e.target.value as RepositoryConfig['defaultDelivery'] })}><option value="patch">人工审查补丁</option><option value="pull-request">审批后创建修复 PR</option></select></label>
    <label>环境准备<select className={inputClass} value={config.preparation} onChange={(e) => onChange({ ...config, preparation: e.target.value as RepositoryConfig['preparation'] })}>
      <option value="image">使用已有镜像</option><option value="requirements">安装公开、带哈希的 wheel 依赖</option></select></label>
    <label>镜像名称或 ID<input className={inputClass} value={config.image} onChange={(e) => onChange({ ...config, image: e.target.value })} /></label>
    <label>仓库内工作目录<input className={inputClass} value={config.workdir} onChange={(e) => onChange({ ...config, workdir: e.target.value })} /></label>
    {arrays.map(([key, label]) => <label key={key}>{label}<textarea className={inputClass} rows={3} value={config[key].join('\n')} onChange={(e) => onChange({ ...config, [key]: lines(e.target.value) })} /></label>)}
  </div>;
}
