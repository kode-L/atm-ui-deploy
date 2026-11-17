'use client';
import React, { ReactNode, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';

/**
 * Section card. `collapsible` turns the title into a toggle (closed unless `defaultOpen`) - used for
 * rarely-used cards such as the Deploy tab's deploy/upgrade steps.
 */
export default function Card({ children, title, icon, className = '', collapsible = false, defaultOpen = false }: {
  children: ReactNode;
  title?: ReactNode;
  icon?: ReactNode;
  className?: string;
  collapsible?: boolean;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(!collapsible || defaultOpen);
  return (
    <div className={`bg-surface-secondary rounded-xl shadow-lg shadow-black/20 p-5 ${className}`}>
      {title && (
        collapsible ? (
          <button type="button" onClick={() => setOpen(o => !o)} className={`w-full flex items-center gap-2 text-left ${open ? 'mb-4' : ''}`}>
            {open ? <ChevronDown className="w-4 h-4 text-txt-secondary" /> : <ChevronRight className="w-4 h-4 text-txt-secondary" />}
            {icon}
            <h3 className="text-lg font-semibold">{title}</h3>
          </button>
        ) : (
          <div className="flex items-center gap-2 mb-4">
            {icon}
            <h3 className="text-lg font-semibold">{title}</h3>
          </div>
        )
      )}
      {open && children}
    </div>
  );
}
