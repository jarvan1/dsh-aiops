package kube

import (
	"sort"
	"strings"
)

// Resource is one entry in the closed read allowlist. It mirrors the native
// TypeScript provider so a remote agent answers exactly the same resources the
// in-process provider does, and nothing else.
type Resource struct {
	// APIPath is the versioned API prefix, for example /api/v1.
	APIPath string
	// Plural is the collection segment, for example pods.
	Plural string
	// Namespaced reports whether the resource lives under a namespace.
	Namespaced bool
}

var core = "/api/v1"

// Resources is the allowlist keyed by the singular and plural names the tools
// accept. Adding a resource here is the only way to widen the agent's surface.
var Resources = map[string]Resource{
	"pod":                    {APIPath: core, Plural: "pods", Namespaced: true},
	"pods":                   {APIPath: core, Plural: "pods", Namespaced: true},
	"service":                {APIPath: core, Plural: "services", Namespaced: true},
	"services":               {APIPath: core, Plural: "services", Namespaced: true},
	"endpoint":               {APIPath: core, Plural: "endpoints", Namespaced: true},
	"endpoints":              {APIPath: core, Plural: "endpoints", Namespaced: true},
	"configmap":              {APIPath: core, Plural: "configmaps", Namespaced: true},
	"configmaps":             {APIPath: core, Plural: "configmaps", Namespaced: true},
	"persistentvolumeclaim":  {APIPath: core, Plural: "persistentvolumeclaims", Namespaced: true},
	"persistentvolumeclaims": {APIPath: core, Plural: "persistentvolumeclaims", Namespaced: true},
	"pvc":                    {APIPath: core, Plural: "persistentvolumeclaims", Namespaced: true},
	"node":                   {APIPath: core, Plural: "nodes"},
	"nodes":                  {APIPath: core, Plural: "nodes"},
	"namespace":              {APIPath: core, Plural: "namespaces"},
	"namespaces":             {APIPath: core, Plural: "namespaces"},
	"persistentvolume":       {APIPath: core, Plural: "persistentvolumes"},
	"persistentvolumes":      {APIPath: core, Plural: "persistentvolumes"},
	"pv":                     {APIPath: core, Plural: "persistentvolumes"},
	"deployment":             {APIPath: "/apis/apps/v1", Plural: "deployments", Namespaced: true},
	"deployments":            {APIPath: "/apis/apps/v1", Plural: "deployments", Namespaced: true},
	"statefulset":            {APIPath: "/apis/apps/v1", Plural: "statefulsets", Namespaced: true},
	"statefulsets":           {APIPath: "/apis/apps/v1", Plural: "statefulsets", Namespaced: true},
	"daemonset":              {APIPath: "/apis/apps/v1", Plural: "daemonsets", Namespaced: true},
	"daemonsets":             {APIPath: "/apis/apps/v1", Plural: "daemonsets", Namespaced: true},
	"replicaset":             {APIPath: "/apis/apps/v1", Plural: "replicasets", Namespaced: true},
	"replicasets":            {APIPath: "/apis/apps/v1", Plural: "replicasets", Namespaced: true},
	"job":                    {APIPath: "/apis/batch/v1", Plural: "jobs", Namespaced: true},
	"jobs":                   {APIPath: "/apis/batch/v1", Plural: "jobs", Namespaced: true},
	"cronjob":                {APIPath: "/apis/batch/v1", Plural: "cronjobs", Namespaced: true},
	"cronjobs":               {APIPath: "/apis/batch/v1", Plural: "cronjobs", Namespaced: true},
}

// CapabilityResources returns the canonical plural resource names an agent can
// read, deduplicated and sorted, for the hello handshake.
func CapabilityResources() []string {
	seen := map[string]bool{}
	var names []string
	for _, resource := range Resources {
		if seen[resource.Plural] {
			continue
		}
		seen[resource.Plural] = true
		names = append(names, resource.Plural)
	}
	sort.Strings(names)
	return names
}

// Lookup resolves one tool-supplied resource name against the allowlist.
func Lookup(name string) (Resource, bool) {
	resource, ok := Resources[strings.ToLower(strings.TrimSpace(name))]
	return resource, ok
}
