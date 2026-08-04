'use client';
import React, { ReactNode } from 'react';

export default function Card({ children, title, icon, className = '' }: {
  children: ReactNode;
  title?: ReactNode;
  icon?: ReactNode;
  className?: string;
}) {
  return (
    <div className={`bg-surface-secondary rounded-xl shadow-lg shadow-black/20 p-5 ${className}`}>
      {title && (
        <div className="flex items-center gap-2 mb-4">
          {icon}
          <h3 className="text-lg font-semibold">{title}</h3>
        </div>
      )}
      {children}
    </div>
  );
}
