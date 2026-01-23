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
    
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    
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
const Sidebar = ({ isCollapsed, toggleSidebar }) => {
  const [activeItem, setActiveItem] = useState('dashboard');
  
  const menuItems = [
    { id: 'dashboard', label: 'Dashboard', icon: 'fas fa-tachometer-alt' },
    { id: 'users', label: 'Users', icon: 'fas fa-users' },
    { id: 'trips', label: 'Trips', icon: 'fas fa-route' },
    { id: 'organizations', label: 'Organizations', icon: 'fas fa-building' },
    { id: 'monitoring', label: 'Monitoring', icon: 'fas fa-chart-line' },
    { id: 'compliance', label: 'Compliance', icon: 'fas fa-shield-alt' },
    { id: 'settings', label: 'Settings', icon: 'fas fa-cog' },
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
            onClick: () => setActiveItem(item.id),
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
        React.createElement('div', className: 'metric-value' }, `${stats.sla.availability}%`),
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

// Main App Component
const App = () => {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [currentView, setCurrentView] = useState('dashboard');
  
  const toggleSidebar = () => {
    setSidebarCollapsed(!sidebarCollapsed);
  };
  
  const renderContent = () => {
    switch (currentView) {
      case 'dashboard':
        return React.createElement(Dashboard);
      case 'users':
        return React.createElement(UsersManagement);
      default:
        return React.createElement(Dashboard);
    }
  };
  
  return React.createElement('div', { className: 'flex h-screen bg-gray-50' },
    React.createElement(Sidebar, {
      isCollapsed: sidebarCollapsed,
      toggleSidebar: toggleSidebar
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