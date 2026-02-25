// Klubz Admin Portal React Application

const { useState, useEffect, useCallback } = React;

// API Configuration
const API_BASE_URL = window.location.origin + '/api';

// Utility Functions
const formatCurrency = (amount, currency = 'ZAR') => {
  return new Intl.NumberFormat('en-ZA', {
    style: 'currency',
    currency: currency,
  }).format(amount);
};

const formatDate = (dateString) => {
  return new Date(dateString).toLocaleDateString('en-ZA', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
};

const formatDateTime = (dateString) => {
  return new Date(dateString).toLocaleString('en-ZA', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
};

// API Service
const apiService = {
  async get(endpoint) {
    const response = await fetch(`${API_BASE_URL}${endpoint}`, {
      headers: {
        'Authorization': `Bearer ${localStorage.getItem('accessToken')}`,
        'Content-Type': 'application/json',
      },
    });
    
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    
    return response.json();
  },
  
  async post(endpoint, data) {
    const response = await fetch(`${API_BASE_URL}${endpoint}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${localStorage.getItem('accessToken')}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(data),
    });
    if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
    return response.json();
  },

  async put(endpoint, data) {
    const response = await fetch(`${API_BASE_URL}${endpoint}`, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${localStorage.getItem('accessToken')}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(data),
    });
    if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
    return response.json();
  },
};

// Loading Component
const Loading = () => (
  React.createElement('div', { className: 'flex items-center justify-center p-8' },
    React.createElement('div', { className: 'loading' })
  )
);

// Error Component
const ErrorMessage = ({ message, onRetry }) => (
  React.createElement('div', { className: 'text-center p-8' },
    React.createElement('div', { className: 'alert alert-error mb-4' }, message),
    onRetry && React.createElement('button', {
      onClick: onRetry,
      className: 'btn btn-primary'
    }, 'Retry')
  )
);

// Sidebar Component
const Sidebar = ({ isCollapsed, toggleSidebar, currentView, setView }) => {
  const activeItem = currentView;
  
  const menuItems = [
    { id: 'dashboard',    label: 'Dashboard',    icon: 'fas fa-tachometer-alt' },
    { id: 'users',        label: 'Users',         icon: 'fas fa-users' },
    { id: 'organizations',label: 'Organizations', icon: 'fas fa-building' },
    { id: 'documents',    label: 'Documents',     icon: 'fas fa-id-card' },
    { id: 'disputes',     label: 'Disputes',      icon: 'fas fa-gavel' },
    { id: 'promo-codes',  label: 'Promo Codes',   icon: 'fas fa-tags' },
    { id: 'audit-logs',   label: 'Audit Logs',    icon: 'fas fa-shield-alt' },
    { id: 'analytics',    label: 'Analytics',     icon: 'fas fa-chart-line' },
  ];
  
  return React.createElement('div', {
    className: `sidebar ${isCollapsed ? 'collapsed' : ''} fixed left-0 top-0 h-full transition-all duration-300 z-50`
  },
    React.createElement('div', { className: 'p-4' },
      React.createElement('div', { className: 'flex items-center justify-between mb-8' },
        !isCollapsed && React.createElement('h1', { className: 'text-xl font-bold' }, 'Klubz Admin'),
        React.createElement('button', {
          onClick: toggleSidebar,
          className: 'text-white hover:text-gray-300'
        }, React.createElement('i', { className: 'fas fa-bars' }))
      ),
      
      React.createElement('nav', { className: 'space-y-2' },
        menuItems.map(item =>
          React.createElement('div', {
            key: item.id,
            onClick: () => setView(item.id),
            className: `nav-item ${activeItem === item.id ? 'active' : ''} p-3 cursor-pointer`
          },
            React.createElement('i', { className: `${item.icon} mr-3` }),
            !isCollapsed && item.label
          )
        )
      )
    )
  );
};

// Dashboard Component
const Dashboard = () => {
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  
  useEffect(() => {
    fetchStats();
  }, []);
  
  const fetchStats = async () => {
    try {
      setLoading(true);
      const data = await apiService.get('/admin/stats');
      setStats(data);
      setError(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };
  
  if (loading) return React.createElement(Loading);
  if (error) return React.createElement(ErrorMessage, { message: error, onRetry: fetchStats });
  
  return React.createElement('div', { className: 'p-6' },
    React.createElement('div', { className: 'mb-8' },
      React.createElement('h1', { className: 'text-3xl font-bold text-gray-900 mb-2' }, 'Dashboard'),
      React.createElement('p', { className: 'text-gray-600' }, 'Overview of your Klubz platform performance')
    ),
    
    React.createElement('div', { className: 'grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 mb-8' },
      React.createElement('div', { className: 'metric-card' },
        React.createElement('div', { className: 'metric-value' }, stats.totalUsers),
        React.createElement('div', { className: 'metric-label' }, 'Total Users')
      ),
      React.createElement('div', { className: 'metric-card' },
        React.createElement('div', { className: 'metric-value' }, stats.totalTrips),
        React.createElement('div', { className: 'metric-label' }, 'Total Trips')
      ),
      React.createElement('div', { className: 'metric-card' },
        React.createElement('div', { className: 'metric-value' }, formatCurrency(stats.revenue.total)),
        React.createElement('div', { className: 'metric-label' }, 'Revenue')
      ),
      React.createElement('div', { className: 'metric-card' },
        React.createElement('div', { className: 'metric-value' }, stats.sla ? `${stats.sla.availability}%` : '--'),
        React.createElement('div', { className: 'metric-label' }, 'Uptime')
      )
    ),
    
    React.createElement('div', { className: 'grid grid-cols-1 lg:grid-cols-2 gap-6' },
      React.createElement('div', { className: 'card p-6' },
        React.createElement('h3', { className: 'text-lg font-semibold mb-4' }, 'Recent Activity'),
        React.createElement('div', { className: 'space-y-4' },
          React.createElement('div', { className: 'flex items-center justify-between' },
            React.createElement('span', null, 'New users today'),
            React.createElement('span', { className: 'font-semibold' }, '12')
          ),
          React.createElement('div', { className: 'flex items-center justify-between' },
            React.createElement('span', null, 'Trips completed'),
            React.createElement('span', { className: 'font-semibold' }, '45')
          ),
          React.createElement('div', { className: 'flex items-center justify-between' },
            React.createElement('span', null, 'Carbon saved (kg)'),
            React.createElement('span', { className: 'font-semibold' }, '95.2')
          )
        )
      ),
      
      React.createElement('div', { className: 'card p-6' },
        React.createElement('h3', { className: 'text-lg font-semibold mb-4' }, 'System Status'),
        React.createElement('div', { className: 'space-y-4' },
          React.createElement('div', { className: 'flex items-center justify-between' },
            React.createElement('span', null, 'API Status'),
            React.createElement('span', { className: 'status-badge status-active' }, 'Healthy')
          ),
          React.createElement('div', { className: 'flex items-center justify-between' },
            React.createElement('span', null, 'Database'),
            React.createElement('span', { className: 'status-badge status-active' }, 'Connected')
          ),
          React.createElement('div', { className: 'flex items-center justify-between' },
            React.createElement('span', null, 'External Services'),
            React.createElement('span', { className: 'status-badge status-active' }, 'Operational')
          )
        )
      )
    )
  );
};

// Users Management Component
const UsersManagement = () => {
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  
  useEffect(() => {
    fetchUsers();
  }, []);
  
  const fetchUsers = async () => {
    try {
      setLoading(true);
      const data = await apiService.get('/admin/users');
      setUsers(data.users);
      setError(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };
  
  if (loading) return React.createElement(Loading);
  if (error) return React.createElement(ErrorMessage, { message: error, onRetry: fetchUsers });
  
  return React.createElement('div', { className: 'p-6' },
    React.createElement('div', { className: 'mb-8 flex justify-between items-center' },
      React.createElement('div', null,
        React.createElement('h1', { className: 'text-3xl font-bold text-gray-900 mb-2' }, 'Users Management'),
        React.createElement('p', { className: 'text-gray-600' }, 'Manage platform users and their permissions')
      ),
      React.createElement('button', { className: 'btn btn-primary' },
        React.createElement('i', { className: 'fas fa-plus mr-2' }),
        'Add User'
      )
    ),
    
    React.createElement('div', { className: 'card' },
      React.createElement('div', { className: 'table-container' },
        React.createElement('table', { className: 'data-table' },
          React.createElement('thead', null,
            React.createElement('tr', null,
              React.createElement('th', null, 'Name'),
              React.createElement('th', null, 'Email'),
              React.createElement('th', null, 'Role'),
              React.createElement('th', null, 'Status'),
              React.createElement('th', null, 'Last Login'),
              React.createElement('th', null, 'Actions')
            )
          ),
          React.createElement('tbody', null,
            users.map(user =>
              React.createElement('tr', { key: user.id },
                React.createElement('td', null, user.name),
                React.createElement('td', null, user.email),
                React.createElement('td', null,
                  React.createElement('span', { className: 'capitalize' }, user.role)
                ),
                React.createElement('td', null,
                  React.createElement('span', { className: `status-badge status-${user.status}` }, user.status)
                ),
                React.createElement('td', null, formatDateTime(user.lastLoginAt)),
                React.createElement('td', null,
                  React.createElement('button', { className: 'text-blue-600 hover:text-blue-800 mr-2' },
                    React.createElement('i', { className: 'fas fa-edit' })
                  ),
                  React.createElement('button', { className: 'text-red-600 hover:text-red-800' },
                    React.createElement('i', { className: 'fas fa-trash' })
                  )
                )
              )
            )
          )
        )
      )
    )
  );
};

// ─── Documents Queue Component ───
const DocumentsQueue = () => {
  const [docs, setDocs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);

  const fetchDocs = useCallback(async () => {
    try {
      setLoading(true);
      const data = await apiService.get(`/admin/documents?page=${page}&status=pending`);
      setDocs(data.documents || []);
    } catch (err) {
      console.error(err);
    } finally { setLoading(false); }
  }, [page]);

  useEffect(() => { fetchDocs(); }, [fetchDocs]);

  const handleVerify = async (id, status, reason) => {
    try {
      await apiService.put(`/admin/documents/${id}`, { status, rejectionReason: reason || undefined });
      fetchDocs();
    } catch (err) { alert(err.message); }
  };

  if (loading) return React.createElement(Loading);

  return React.createElement('div', { className: 'p-6' },
    React.createElement('h1', { className: 'text-3xl font-bold text-gray-900 mb-6' }, 'Driver Document Verification'),
    React.createElement('div', { className: 'card' },
      React.createElement('div', { className: 'table-container' },
        React.createElement('table', { className: 'data-table' },
          React.createElement('thead', null,
            React.createElement('tr', null,
              ['User ID', 'Doc Type', 'Status', 'Submitted', 'Actions'].map(h =>
                React.createElement('th', { key: h }, h)
              )
            )
          ),
          React.createElement('tbody', null,
            docs.length === 0 && React.createElement('tr', null,
              React.createElement('td', { colSpan: 5, className: 'text-center text-gray-400 py-8' }, 'No pending documents')
            ),
            docs.map(doc =>
              React.createElement('tr', { key: doc.id },
                React.createElement('td', null, doc.user_id),
                React.createElement('td', null, doc.doc_type.replace(/_/g, ' ')),
                React.createElement('td', null, React.createElement('span', { className: `status-badge status-${doc.status}` }, doc.status)),
                React.createElement('td', null, formatDate(doc.created_at)),
                React.createElement('td', null,
                  doc.status === 'pending' && React.createElement('div', { className: 'flex gap-2' },
                    React.createElement('button', {
                      className: 'btn btn-sm btn-success',
                      onClick: () => handleVerify(doc.id, 'approved', null),
                    }, 'Approve'),
                    React.createElement('button', {
                      className: 'btn btn-sm btn-danger',
                      onClick: () => { const r = prompt('Rejection reason:'); if (r) handleVerify(doc.id, 'rejected', r); },
                    }, 'Reject')
                  )
                )
              )
            )
          )
        )
      )
    )
  );
};

// ─── Disputes Component ───
const Disputes = () => {
  const [disputes, setDisputes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState('open');

  const fetchDisputes = useCallback(async () => {
    try {
      setLoading(true);
      const data = await apiService.get(`/admin/disputes?status=${statusFilter}&page=1`);
      setDisputes(data.disputes || []);
    } catch (err) { console.error(err); }
    finally { setLoading(false); }
  }, [statusFilter]);

  useEffect(() => { fetchDisputes(); }, [fetchDisputes]);

  const handleResolve = async (id) => {
    const resolution = prompt('Enter resolution notes:');
    if (!resolution) return;
    const refundStr = prompt('Refund amount in cents (0 for no refund):');
    const refundCents = parseInt(refundStr || '0', 10);
    try {
      await apiService.put(`/admin/disputes/${id}`, { status: 'resolved', resolution, refundCents: refundCents || 0 });
      fetchDisputes();
    } catch (err) { alert(err.message); }
  };

  if (loading) return React.createElement(Loading);

  return React.createElement('div', { className: 'p-6' },
    React.createElement('div', { className: 'flex justify-between items-center mb-6' },
      React.createElement('h1', { className: 'text-3xl font-bold text-gray-900' }, 'Disputes'),
      React.createElement('select', {
        className: 'border rounded px-3 py-2',
        value: statusFilter,
        onChange: e => setStatusFilter(e.target.value),
      },
        ['open', 'investigating', 'resolved', 'closed'].map(s =>
          React.createElement('option', { key: s, value: s }, s.charAt(0).toUpperCase() + s.slice(1))
        )
      )
    ),
    React.createElement('div', { className: 'card' },
      React.createElement('div', { className: 'table-container' },
        React.createElement('table', { className: 'data-table' },
          React.createElement('thead', null,
            React.createElement('tr', null,
              ['ID', 'Trip', 'Filed By', 'Reason', 'Status', 'Actions'].map(h =>
                React.createElement('th', { key: h }, h)
              )
            )
          ),
          React.createElement('tbody', null,
            disputes.length === 0 && React.createElement('tr', null,
              React.createElement('td', { colSpan: 6, className: 'text-center text-gray-400 py-8' }, 'No disputes found')
            ),
            disputes.map(d =>
              React.createElement('tr', { key: d.id },
                React.createElement('td', null, d.id),
                React.createElement('td', null, d.trip_id),
                React.createElement('td', null, d.filed_by),
                React.createElement('td', null, d.reason && d.reason.slice(0, 60) + (d.reason.length > 60 ? '…' : '')),
                React.createElement('td', null, React.createElement('span', { className: `status-badge status-${d.status}` }, d.status)),
                React.createElement('td', null,
                  d.status === 'open' && React.createElement('button', {
                    className: 'btn btn-sm btn-primary',
                    onClick: () => handleResolve(d.id),
                  }, 'Resolve')
                )
              )
            )
          )
        )
      )
    )
  );
};

// ─── Promo Codes Component ───
const PromoCodes = () => {
  const [codes, setCodes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ code: '', discount_type: 'percent', discount_value: 10, max_uses: '', expires_at: '' });

  const fetchCodes = useCallback(async () => {
    try {
      setLoading(true);
      const data = await apiService.get('/admin/promo-codes');
      setCodes(data.promoCodes || []);
    } catch (err) { console.error(err); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { fetchCodes(); }, [fetchCodes]);

  const handleCreate = async (e) => {
    e.preventDefault();
    try {
      await apiService.post('/admin/promo-codes', {
        ...form,
        discount_value: parseInt(form.discount_value, 10),
        max_uses: form.max_uses ? parseInt(form.max_uses, 10) : null,
        expires_at: form.expires_at || null,
      });
      setShowForm(false);
      fetchCodes();
    } catch (err) { alert(err.message); }
  };

  const handleToggle = async (id, isActive) => {
    try {
      await apiService.put(`/admin/promo-codes/${id}`, { isActive: !isActive });
      fetchCodes();
    } catch (err) { alert(err.message); }
  };

  if (loading) return React.createElement(Loading);

  return React.createElement('div', { className: 'p-6' },
    React.createElement('div', { className: 'flex justify-between items-center mb-6' },
      React.createElement('h1', { className: 'text-3xl font-bold text-gray-900' }, 'Promo Codes'),
      React.createElement('button', { className: 'btn btn-primary', onClick: () => setShowForm(!showForm) },
        showForm ? 'Cancel' : '+ New Code'
      )
    ),

    showForm && React.createElement('div', { className: 'card p-6 mb-6' },
      React.createElement('form', { onSubmit: handleCreate, className: 'grid grid-cols-2 gap-4' },
        React.createElement('div', null,
          React.createElement('label', { className: 'block text-sm font-medium mb-1' }, 'Code'),
          React.createElement('input', { className: 'border rounded px-3 py-2 w-full', value: form.code, onChange: e => setForm({ ...form, code: e.target.value.toUpperCase() }), required: true, placeholder: 'SAVE20' })
        ),
        React.createElement('div', null,
          React.createElement('label', { className: 'block text-sm font-medium mb-1' }, 'Discount Type'),
          React.createElement('select', { className: 'border rounded px-3 py-2 w-full', value: form.discount_type, onChange: e => setForm({ ...form, discount_type: e.target.value }) },
            React.createElement('option', { value: 'percent' }, 'Percent'),
            React.createElement('option', { value: 'fixed_cents' }, 'Fixed (cents)')
          )
        ),
        React.createElement('div', null,
          React.createElement('label', { className: 'block text-sm font-medium mb-1' }, 'Value'),
          React.createElement('input', { type: 'number', className: 'border rounded px-3 py-2 w-full', value: form.discount_value, onChange: e => setForm({ ...form, discount_value: e.target.value }), required: true })
        ),
        React.createElement('div', null,
          React.createElement('label', { className: 'block text-sm font-medium mb-1' }, 'Max Uses (blank = unlimited)'),
          React.createElement('input', { type: 'number', className: 'border rounded px-3 py-2 w-full', value: form.max_uses, onChange: e => setForm({ ...form, max_uses: e.target.value }), placeholder: 'Unlimited' })
        ),
        React.createElement('div', null,
          React.createElement('label', { className: 'block text-sm font-medium mb-1' }, 'Expires At'),
          React.createElement('input', { type: 'date', className: 'border rounded px-3 py-2 w-full', value: form.expires_at, onChange: e => setForm({ ...form, expires_at: e.target.value }) })
        ),
        React.createElement('div', { className: 'col-span-2' },
          React.createElement('button', { type: 'submit', className: 'btn btn-primary' }, 'Create Code')
        )
      )
    ),

    React.createElement('div', { className: 'card' },
      React.createElement('div', { className: 'table-container' },
        React.createElement('table', { className: 'data-table' },
          React.createElement('thead', null,
            React.createElement('tr', null,
              ['Code', 'Type', 'Value', 'Uses', 'Expires', 'Active', 'Actions'].map(h =>
                React.createElement('th', { key: h }, h)
              )
            )
          ),
          React.createElement('tbody', null,
            codes.map(c =>
              React.createElement('tr', { key: c.id },
                React.createElement('td', null, React.createElement('code', null, c.code)),
                React.createElement('td', null, c.discount_type),
                React.createElement('td', null, c.discount_type === 'percent' ? `${c.discount_value}%` : `R${(c.discount_value / 100).toFixed(2)}`),
                React.createElement('td', null, `${c.uses_count}${c.max_uses ? ` / ${c.max_uses}` : ''}`),
                React.createElement('td', null, c.expires_at ? formatDate(c.expires_at) : 'Never'),
                React.createElement('td', null, React.createElement('span', { className: `status-badge ${c.is_active ? 'status-active' : 'status-inactive'}` }, c.is_active ? 'Active' : 'Inactive')),
                React.createElement('td', null,
                  React.createElement('button', {
                    className: `btn btn-sm ${c.is_active ? 'btn-danger' : 'btn-success'}`,
                    onClick: () => handleToggle(c.id, c.is_active),
                  }, c.is_active ? 'Deactivate' : 'Activate')
                )
              )
            )
          )
        )
      )
    )
  );
};

// ─── Audit Logs Component ───
const AuditLogs = () => {
  const [logs, setLogs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);

  const fetchLogs = useCallback(async () => {
    try {
      setLoading(true);
      const data = await apiService.get(`/admin/logs?page=${page}&limit=50`);
      setLogs(data.logs || data.auditLogs || []);
    } catch (err) { console.error(err); }
    finally { setLoading(false); }
  }, [page]);

  useEffect(() => { fetchLogs(); }, [fetchLogs]);

  if (loading) return React.createElement(Loading);

  return React.createElement('div', { className: 'p-6' },
    React.createElement('div', { className: 'flex justify-between items-center mb-6' },
      React.createElement('h1', { className: 'text-3xl font-bold text-gray-900' }, 'Audit Logs'),
      React.createElement('div', { className: 'flex gap-2' },
        React.createElement('button', { className: 'btn btn-sm', onClick: () => setPage(p => Math.max(1, p - 1)), disabled: page === 1 }, '← Prev'),
        React.createElement('span', { className: 'px-3 py-2 text-sm' }, `Page ${page}`),
        React.createElement('button', { className: 'btn btn-sm', onClick: () => setPage(p => p + 1) }, 'Next →')
      )
    ),
    React.createElement('div', { className: 'card' },
      React.createElement('div', { className: 'table-container' },
        React.createElement('table', { className: 'data-table' },
          React.createElement('thead', null,
            React.createElement('tr', null,
              ['Time', 'User', 'Action', 'Resource', 'Success', 'IP'].map(h =>
                React.createElement('th', { key: h }, h)
              )
            )
          ),
          React.createElement('tbody', null,
            logs.map((log, i) =>
              React.createElement('tr', { key: log.id || i },
                React.createElement('td', null, formatDateTime(log.created_at)),
                React.createElement('td', null, log.user_id),
                React.createElement('td', null, React.createElement('code', { className: 'text-xs' }, log.action)),
                React.createElement('td', null, log.resource_type),
                React.createElement('td', null, log.success
                  ? React.createElement('span', { className: 'text-green-600' }, '✓')
                  : React.createElement('span', { className: 'text-red-600' }, '✗')
                ),
                React.createElement('td', null, log.ip_address)
              )
            )
          )
        )
      )
    )
  );
};

// ─── Analytics Component ───
const Analytics = () => {
  const [tripsData, setTripsData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        const data = await apiService.get('/admin/analytics/trips-over-time');
        setTripsData(data.weeks || []);
      } catch { setTripsData([]); }
      finally { setLoading(false); }
    })();
  }, []);

  if (loading) return React.createElement(Loading);

  return React.createElement('div', { className: 'p-6' },
    React.createElement('h1', { className: 'text-3xl font-bold text-gray-900 mb-6' }, 'Analytics'),
    React.createElement('div', { className: 'card p-6 mb-6' },
      React.createElement('h3', { className: 'text-lg font-semibold mb-4' }, 'Trips Over Time (last 90 days)'),
      tripsData && tripsData.length > 0
        ? React.createElement('div', { className: 'overflow-x-auto' },
            React.createElement('table', { className: 'data-table' },
              React.createElement('thead', null,
                React.createElement('tr', null,
                  React.createElement('th', null, 'Week'),
                  React.createElement('th', null, 'Trips'),
                  React.createElement('th', null, 'Bar')
                )
              ),
              React.createElement('tbody', null,
                tripsData.map((w, i) => {
                  const max = Math.max(...tripsData.map(x => x.count || 0)) || 1;
                  return React.createElement('tr', { key: i },
                    React.createElement('td', null, w.week),
                    React.createElement('td', null, w.count),
                    React.createElement('td', null,
                      React.createElement('div', {
                        style: { width: `${Math.round((w.count / max) * 200)}px`, height: '16px', background: '#3B82F6', borderRadius: '4px' }
                      })
                    )
                  );
                })
              )
            )
          )
        : React.createElement('p', { className: 'text-gray-400' }, 'No data available yet.')
    )
  );
};

// ─── Organizations Component ───
const Organizations = () => {
  const [orgs, setOrgs] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        const data = await apiService.get('/admin/organizations');
        setOrgs(data.organizations || []);
      } catch { setOrgs([]); }
      finally { setLoading(false); }
    })();
  }, []);

  if (loading) return React.createElement(Loading);

  return React.createElement('div', { className: 'p-6' },
    React.createElement('h1', { className: 'text-3xl font-bold text-gray-900 mb-6' }, 'Organizations'),
    React.createElement('div', { className: 'card' },
      React.createElement('div', { className: 'table-container' },
        React.createElement('table', { className: 'data-table' },
          React.createElement('thead', null,
            React.createElement('tr', null,
              ['ID', 'Name', 'Invite Code', 'Active', 'Created'].map(h =>
                React.createElement('th', { key: h }, h)
              )
            )
          ),
          React.createElement('tbody', null,
            orgs.length === 0 && React.createElement('tr', null,
              React.createElement('td', { colSpan: 5, className: 'text-center text-gray-400 py-8' }, 'No organizations found')
            ),
            orgs.map(org =>
              React.createElement('tr', { key: org.id },
                React.createElement('td', null, org.id),
                React.createElement('td', null, org.name),
                React.createElement('td', null, React.createElement('code', null, org.invite_code || '—')),
                React.createElement('td', null, org.is_active ? '✓' : '✗'),
                React.createElement('td', null, formatDate(org.created_at))
              )
            )
          )
        )
      )
    )
  );
};

// Main App Component
const App = () => {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [currentView, setCurrentView] = useState('dashboard');
  
  const toggleSidebar = () => {
    setSidebarCollapsed(!sidebarCollapsed);
  };
  
  const renderContent = () => {
    switch (currentView) {
      case 'dashboard':      return React.createElement(Dashboard);
      case 'users':          return React.createElement(UsersManagement);
      case 'organizations':  return React.createElement(Organizations);
      case 'documents':      return React.createElement(DocumentsQueue);
      case 'disputes':       return React.createElement(Disputes);
      case 'promo-codes':    return React.createElement(PromoCodes);
      case 'audit-logs':     return React.createElement(AuditLogs);
      case 'analytics':      return React.createElement(Analytics);
      default:               return React.createElement(Dashboard);
    }
  };
  
  return React.createElement('div', { className: 'flex h-screen bg-gray-50' },
    React.createElement(Sidebar, {
      isCollapsed: sidebarCollapsed,
      toggleSidebar: toggleSidebar,
      currentView: currentView,
      setView: setCurrentView,
    }),
    React.createElement('div', {
      className: `flex-1 overflow-auto transition-all duration-300 ${
        sidebarCollapsed ? 'ml-20' : 'ml-64'
      }`
    },
      renderContent()
    )
  );
};

// Initialize the app
const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(React.createElement(App));