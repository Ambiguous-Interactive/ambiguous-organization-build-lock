package mergepolicy

// AuditedRepository records one consumer whose live merge settings were read.
type AuditedRepository struct {
	Repository    string `json:"repository"`
	DefaultBranch string `json:"defaultBranch"`
}

// Audit is the bounded, source-free artifact consumed by issue sync. It
// contains repository names, default branches, check contexts, ruleset
// metadata, and reason codes only. It never contains credentials or matched
// source lines.
type Audit struct {
	Complete     bool                `json:"complete"`
	Repositories []AuditedRepository `json:"repositories"`
	Inventory    []InventoryEntry    `json:"inventory"`
	Findings     []Finding           `json:"findings"`
}

// Clean reports whether the audit proved the reviewed merge policy without
// findings. An incomplete audit is never clean.
func (audit Audit) Clean() bool {
	return audit.Complete && len(audit.Findings) == 0
}
