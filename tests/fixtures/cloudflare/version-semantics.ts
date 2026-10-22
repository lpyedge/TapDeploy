// Contract-derived lifecycle model, not a claim of live authorization.
// Sources/uncertainties: docs/cloudflare-version-contract.md.
export class VersionSemantics {
  versions: { id: string; bindings: Record<string, string> }[] = [];
  active?: string;
  served: Record<string, string>[] = [];
  constructor(private secretImplicitDeploy: boolean) {}
  upload(bindings: Record<string, string>, deploy = false): string {
    const id = `v${this.versions.length + 1}`;
    this.versions.push({ id, bindings: { ...bindings } });
    if (deploy) this.deploy(id);
    return id;
  }
  secret(name: string, value: string): string {
    const latest = this.versions.at(-1);
    if (!latest) throw new Error("missing script");
    return this.upload({ ...latest.bindings, [name]: value }, this.secretImplicitDeploy);
  }
  bulk(secrets: Record<string, string | null>): string {
    const latest = this.versions.at(-1);
    if (!latest) throw new Error("missing script");
    const bindings = { ...latest.bindings };
    for (const [name, value] of Object.entries(secrets)) {
      if (value === null) delete bindings[name]; else bindings[name] = value;
    }
    return this.upload(bindings, this.secretImplicitDeploy);
  }
  inherit(activeId: string, name: string): string {
    const latest = this.versions.at(-1);
    if (latest?.id !== activeId || latest.bindings[name] === undefined) throw new Error("unverified latest inheritance");
    return latest.bindings[name];
  }
  deploy(id: string): void {
    const version = this.versions.find(v => v.id === id);
    if (!version) throw new Error("unknown version");
    this.active = id;
    this.served.push({ ...version.bindings });
  }
}
