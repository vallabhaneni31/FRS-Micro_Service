import React from "react";
import { useAuth } from "../../contexts/AuthContext";

export const ScopeSelector: React.FC = () => {
  const {
    activeScope, setActiveScope,
    tenants, customers, sites, units,
    verticalLabel,
  } = useAuth();

  if (!activeScope) {
    return null;
  }

  const tenantOptions = tenants;
  const customerOptions = customers.filter((customer) => customer.tenantId === activeScope.tenantId);
  const siteOptions = sites.filter((site) =>
    activeScope.customerId ? site.customerId === activeScope.customerId : true
  );
  const unitOptions = units.filter((unit) =>
    activeScope.siteId ? unit.siteId === activeScope.siteId : true
  );

  // Education vs corporate labels — driven by tenants.vertical via verticalLabel().
  const tenantLbl   = verticalLabel("Tenant",    "Institute");
  const customerLbl = verticalLabel("Customer",  "Department");
  const siteLbl     = verticalLabel("Site",      "Campus");
  const unitLbl     = verticalLabel("Unit",      "Classroom");

  return (
    <div className="grid grid-cols-1 gap-2">
      <label className="text-[10px] uppercase tracking-wider text-slate-500">Access Scope</label>
      <div className="grid grid-cols-1 gap-2">
        <select
          aria-label={tenantLbl}
          value={activeScope.tenantId}
          onChange={(event) =>
            setActiveScope({
              tenantId: event.target.value,
            })
          }
          className="w-full rounded-md border border-slate-300 dark:border-slate-700 glass-card px-2 py-1 text-xs"
        >
          {tenantOptions.map((tenant) => (
            <option key={tenant.id} value={tenant.id}>
              {tenant.name}
            </option>
          ))}
        </select>
        <select
          aria-label={customerLbl}
          value={activeScope.customerId ?? ""}
          onChange={(event) =>
            setActiveScope({
              ...activeScope,
              customerId: event.target.value || undefined,
            })
          }
          className="w-full rounded-md border border-slate-300 dark:border-slate-700 glass-card px-2 py-1 text-xs"
        >
          <option value="">All {customerLbl.toLowerCase()}s</option>
          {customerOptions.map((customer) => (
            <option key={customer.id} value={customer.id}>
              {customer.name}
            </option>
          ))}
        </select>
        <select
          aria-label={siteLbl}
          value={activeScope.siteId ?? ""}
          onChange={(event) =>
            setActiveScope({
              ...activeScope,
              siteId: event.target.value || undefined,
            })
          }
          className="w-full rounded-md border border-slate-300 dark:border-slate-700 glass-card px-2 py-1 text-xs"
        >
          <option value="">All {siteLbl.toLowerCase()}s</option>
          {siteOptions.map((site) => (
            <option key={site.id} value={site.id}>
              {site.name}
            </option>
          ))}
        </select>
        <select
          aria-label={unitLbl}
          value={activeScope.unitId ?? ""}
          onChange={(event) =>
            setActiveScope({
              ...activeScope,
              unitId: event.target.value || undefined,
            })
          }
          className="w-full rounded-md border border-slate-300 dark:border-slate-700 glass-card px-2 py-1 text-xs"
        >
          <option value="">All {unitLbl.toLowerCase()}s</option>
          {unitOptions.map((unit) => (
            <option key={unit.id} value={unit.id}>
              {unit.name}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
};
