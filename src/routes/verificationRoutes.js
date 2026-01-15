// src/routes/VerifiedRoute.jsx
import React, { useEffect, useState } from 'react';
import { Navigate, Outlet } from 'react-router-dom';

const API_BASE_URL = (process.env.REACT_APP_API_URL || 'http://localhost:5050').replace(/\/$/, '');

export default function VerifiedRoute() {
  const [loading, setLoading] = useState(true);
  const [allowed, setAllowed] = useState(false);

  useEffect(() => {
    const token = localStorage.getItem('token');

    if (!token) {
      setAllowed(false);
      setLoading(false);
      return;
    }

    const run = async () => {
      try {
        const res = await fetch(`${API_BASE_URL}/api/verification/status`, {
          headers: { Authorization: `Bearer ${token}` },
        });

        const text = await res.text();

        let data = null;
        try {
          data = text ? JSON.parse(text) : null;
        } catch {
          throw new Error(text || 'Non-JSON response from server');
        }

        const status = data?.status || 'PENDING';
        setAllowed(status === 'APPROVED');
      } catch (e) {
        console.error('VerifiedRoute error:', e);
        setAllowed(false);
      } finally {
        setLoading(false);
      }
    };

    run();
  }, []);

  if (loading) return null;
  if (!allowed) return <Navigate to="/verify" replace />;
  return <Outlet />;
}
