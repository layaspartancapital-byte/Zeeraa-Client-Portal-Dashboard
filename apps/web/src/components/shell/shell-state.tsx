'use client';

import { createContext, useContext, useEffect, useState } from 'react';

/**
 * The two pieces of chrome state the sidebar and the top bar both need: whether
 * the rail is collapsed to icons, and whether the off-canvas drawer is open on
 * a phone.
 *
 * A context rather than a prop chain because the hamburger lives in the top bar
 * and the drawer it opens lives in the layout, and they are rendered by
 * different files — the top bar is per page so it can carry that page's title
 * and controls.
 */
type ShellState = {
  collapsed: boolean;
  setCollapsed: (v: boolean) => void;
  drawerOpen: boolean;
  setDrawerOpen: (v: boolean) => void;
};

const Context = createContext<ShellState | null>(null);

const STORAGE_KEY = 'zeeraa.sidebar.collapsed';

export function ShellProvider({ children }: { children: React.ReactNode }) {
  const [collapsed, setCollapsed] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);

  // Remembered across navigations, because a rail that springs back open on
  // every page load is worse than one that does not collapse at all.
  useEffect(() => {
    try {
      if (window.localStorage.getItem(STORAGE_KEY) === '1') setCollapsed(true);
    } catch {
      // A browser with storage blocked keeps the default. Not worth reporting.
    }
  }, []);

  const persist = (v: boolean) => {
    setCollapsed(v);
    try {
      window.localStorage.setItem(STORAGE_KEY, v ? '1' : '0');
    } catch {
      // Ignored for the same reason.
    }
  };

  // The drawer must not survive a navigation: tapping a nav item on a phone
  // should land you on the page, not leave the rail over it.
  useEffect(() => {
    document.body.style.overflow = drawerOpen ? 'hidden' : '';
    return () => {
      document.body.style.overflow = '';
    };
  }, [drawerOpen]);

  return (
    <Context.Provider value={{ collapsed, setCollapsed: persist, drawerOpen, setDrawerOpen }}>
      {children}
    </Context.Provider>
  );
}

export function useShell(): ShellState {
  const value = useContext(Context);
  if (!value) throw new Error('useShell must be used inside ShellProvider');
  return value;
}
