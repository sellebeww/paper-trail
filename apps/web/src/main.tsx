// Copyright (c) 2026 Vassel Goleyu. All rights reserved.
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { WitnessPage } from './witness/WitnessPage';

// Two pages only, so no router: /saksi#<token> is the public witness page.
const page = window.location.pathname.startsWith('/saksi') ? <WitnessPage /> : <App />;

createRoot(document.getElementById('root')!).render(<StrictMode>{page}</StrictMode>);
