import React, { useState, useEffect, useMemo, useRef } from 'react';
import { Search, Filter, Send, Edit3, Clock, Mail, User, MessageSquare, ChevronDown, ChevronRight, X, TrendingUp, Calendar, ExternalLink, BarChart3, Users, AlertCircle, CheckCircle, Timer, Zap, Target, DollarSign, Activity, Key, Brain, Database, Loader2, Save, Phone, LogOut } from 'lucide-react';
import { useAuth } from './AuthContext';
import { supabase } from './supabase';
import Login from './Login';

// Security utilities for API key encryption
const ENCRYPTION_SALT = 'InboxManager_2024_Salt_Key';

const encryptApiKey = (key) => {
  if (!key) return '';
  try {
    // Simple encryption using base64 encoding with salt
    const combined = key + ENCRYPTION_SALT;
    return btoa(combined);
  } catch (error) {
    console.warn('Failed to encrypt API key:', error);
    return key;
  }
};

const decryptApiKey = (encryptedKey) => {
  if (!encryptedKey) return '';
  try {
    const decoded = atob(encryptedKey);
    return decoded.replace(ENCRYPTION_SALT, '');
  } catch (error) {
    console.warn('Failed to decrypt API key, treating as plain text:', error);
    return encryptedKey;
  }
};

// HTML sanitization function (basic XSS protection)
const sanitizeHtml = (html) => {
  if (!html) return '';
  
  // Create a temporary element to parse HTML
  const temp = document.createElement('div');
  temp.innerHTML = html;
  
  // Remove potentially dangerous elements and attributes
  const dangerousElements = ['script', 'object', 'embed', 'iframe', 'form'];
  const dangerousAttributes = ['onload', 'onerror', 'onclick', 'onmouseover', 'onfocus', 'onblur', 'onchange', 'onsubmit'];
  
  dangerousElements.forEach(tagName => {
    const elements = temp.querySelectorAll(tagName);
    elements.forEach(el => el.remove());
  });
  
  // Remove dangerous attributes from all elements
  const allElements = temp.querySelectorAll('*');
  allElements.forEach(el => {
    dangerousAttributes.forEach(attr => {
      if (el.hasAttribute(attr)) {
        el.removeAttribute(attr);
      }
    });
    
    // Remove javascript: URLs
    ['href', 'src'].forEach(attr => {
      const value = el.getAttribute(attr);
      if (value && value.toLowerCase().startsWith('javascript:')) {
        el.removeAttribute(attr);
      }
    });
  });
  
  return temp.innerHTML;
};

const InboxManager = () => {
  // Authentication
  const { user, organizationId, loading: authLoading, signOut } = useAuth();

  // If not authenticated, show login
  if (authLoading) {
    return (
      <div className="flex h-screen items-center justify-center" style={{backgroundColor: '#1A1C1A'}}>
        <div className="text-center p-8 rounded-2xl shadow-xl" style={{backgroundColor: 'rgba(26, 28, 26, 0.8)', border: '1px solid white'}}>
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 mx-auto mb-4" style={{borderColor: '#54FCFF'}}></div>
          <p className="text-white">Loading...</p>
        </div>
      </div>
    );
  }

  if (!user) {
    return <Login />;
  }

  // State for leads from API
  const [leads, setLeads] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // Add new state for enrichment data
  const [enrichmentData, setEnrichmentData] = useState(null);
  const [isEnriching, setIsEnriching] = useState(false);
  const [showEnrichmentPopup, setShowEnrichmentPopup] = useState(false);

  // Add new state for API settings and tab management
  const [activeTab, setActiveTab] = useState('all');
  const [showApiSettings, setShowApiSettings] = useState(false);
  const [apiKeys, setApiKeys] = useState({
    esp: {
      provider: localStorage.getItem('esp_provider') || '',
      key: decryptApiKey(localStorage.getItem('esp_api_key_enc') || '')
    },
    fullenrich: decryptApiKey(localStorage.getItem('fullenrich_api_key_enc') || '')
  });
  const [apiTestStatus, setApiTestStatus] = useState({
    esp: null,
    fullenrich: null
  });
  const [isSavingApi, setIsSavingApi] = useState(false);
  const [showApiToast, setShowApiToast] = useState(false);
  const [apiToastMessage, setApiToastMessage] = useState({ type: '', message: '' });

  // Add new state for searching phone number
  const [isSearchingPhone, setIsSearchingPhone] = useState(false);

  // Replace single loading states with maps of lead IDs
  const [enrichingLeads, setEnrichingLeads] = useState(new Set());
  const [searchingPhoneLeads, setSearchingPhoneLeads] = useState(new Set());

  // Replace single toast with array of toasts
  const [toasts, setToasts] = useState([]);
  const toastsTimeoutRef = useRef({}); // Store timeouts by toast ID

  // Theme management
  const [isDarkMode, setIsDarkMode] = useState(() => {
    const savedTheme = localStorage.getItem('inbox_manager_theme');
    return savedTheme ? savedTheme === 'dark' : true; // Default to dark mode
  });

  // Auto-save drafts state
  const [drafts, setDrafts] = useState(() => {
    try {
      const savedDrafts = localStorage.getItem('inbox_manager_drafts');
      return savedDrafts ? JSON.parse(savedDrafts) : {};
    } catch (e) {
      console.warn('Failed to load saved drafts:', e);
      return {};
    }
  });

  // Recently viewed leads state
  const [recentlyViewed, setRecentlyViewed] = useState(() => {
    try {
      const savedRecent = localStorage.getItem('inbox_manager_recent_leads');
      return savedRecent ? JSON.parse(savedRecent) : [];
    } catch (e) {
      console.warn('Failed to load recently viewed leads:', e);
      return [];
    }
  });
  const [showRecentDropdown, setShowRecentDropdown] = useState(false);

  // Clean up all timeouts on unmount
  useEffect(() => {
    return () => {
      Object.values(toastsTimeoutRef.current).forEach(timeout => {
        clearTimeout(timeout);
      });
      if (draftTimeoutRef.current) {
        clearTimeout(draftTimeoutRef.current);
      }
    };
  }, []);

  // Click outside to close dropdowns
  useEffect(() => {
    const handleClickOutside = (event) => {
      // Close recent dropdown if clicking outside
      if (showRecentDropdown && !event.target.closest('.recent-dropdown')) {
        setShowRecentDropdown(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [showRecentDropdown]);

  // Auto-save drafts with debouncing
  const draftTimeoutRef = useRef(null);
  const [isDraftSaving, setIsDraftSaving] = useState(false);
  
  const saveDraft = (leadId, content, htmlContent) => {
    if (draftTimeoutRef.current) {
      clearTimeout(draftTimeoutRef.current);
    }
    
    setIsDraftSaving(true);
    
    draftTimeoutRef.current = setTimeout(() => {
      const newDrafts = {
        ...drafts,
        [leadId]: {
          content: content.trim(),
          htmlContent: htmlContent || '',
          savedAt: new Date().toISOString()
        }
      };
      
      // Remove empty drafts
      if (!content.trim()) {
        delete newDrafts[leadId];
      }
      
      setDrafts(newDrafts);
      localStorage.setItem('inbox_manager_drafts', JSON.stringify(newDrafts));
      setIsDraftSaving(false);
    }, 2000); // Auto-save after 2 seconds of inactivity
  };

  // Recently viewed leads management
  const addToRecentlyViewed = (lead) => {
    if (!lead) return;
    
    const newRecent = [
      { id: lead.id, name: `${lead.first_name} ${lead.last_name}`, email: lead.email },
      ...recentlyViewed.filter(item => item.id !== lead.id)
    ].slice(0, 8); // Keep only last 8
    
    setRecentlyViewed(newRecent);
    localStorage.setItem('inbox_manager_recent_leads', JSON.stringify(newRecent));
  };



  // Migrate existing unencrypted API keys to encrypted storage (runs once on mount)
  useEffect(() => {
    const migrateApiKeys = () => {
      const keysToMigrate = ['smartlead', 'claude', 'fullenrich'];
      let migrationNeeded = false;

      keysToMigrate.forEach(keyName => {
        const oldKey = localStorage.getItem(`${keyName}_api_key`);
        const newKey = localStorage.getItem(`${keyName}_api_key_enc`);
        
        // If old unencrypted key exists but new encrypted key doesn't
        if (oldKey && !newKey) {
          const encryptedKey = encryptApiKey(oldKey);
          localStorage.setItem(`${keyName}_api_key_enc`, encryptedKey);
          localStorage.removeItem(`${keyName}_api_key`);
          migrationNeeded = true;
        }
      });

      if (migrationNeeded) {
        console.info('API keys migrated to encrypted storage for security');
        showToast('API keys upgraded to encrypted storage', 'success');
      }
    };

    migrateApiKeys();
  }, []);

  // Theme toggle function
  const toggleTheme = () => {
    const newTheme = !isDarkMode;
    setIsDarkMode(newTheme);
    localStorage.setItem('inbox_manager_theme', newTheme ? 'dark' : 'light');
    showToast(`Switched to ${newTheme ? 'dark' : 'light'} mode`, 'success');
  };

  // Theme CSS variables
  const themeStyles = isDarkMode ? {
    // Dark mode colors
    primaryBg: '#1A1C1A',
    secondaryBg: 'rgba(26, 28, 26, 0.8)',
    tertiaryBg: 'rgba(255, 255, 255, 0.05)',
    textPrimary: '#FFFFFF',
    textSecondary: '#D1D5DB',
    textMuted: '#9CA3AF',
    accent: '#54FCFF',
    border: 'rgba(255, 255, 255, 0.1)',
    borderStrong: 'rgba(255, 255, 255, 0.2)',
    success: '#10B981',
    warning: '#F59E0B',
    error: '#EF4444',
  } : {
    // Light mode colors (fixed contrast)
    primaryBg: '#F8FAFC',
    secondaryBg: '#FFFFFF',
    tertiaryBg: '#F1F5F9',
    textPrimary: '#0F172A',
    textSecondary: '#334155',
    textMuted: '#64748B',
    accent: '#2563EB',
    border: 'rgba(0, 0, 0, 0.15)',
    borderStrong: 'rgba(0, 0, 0, 0.25)',
    success: '#059669',
    warning: '#D97706',
    error: '#DC2626',
  };

  // Modified toast helper function
  const showToast = (message, type = 'success', leadId = null) => {
    const id = Date.now(); // Unique ID for each toast
    const newToast = { id, message, type, leadId };
    
    setToasts(currentToasts => [...currentToasts, newToast]);
    
    // Store the timeout reference
    toastsTimeoutRef.current[id] = setTimeout(() => {
      removeToast(id);
    }, 10000);
  };

  // Remove specific toast
  const removeToast = (id) => {
    // Clear the timeout
    if (toastsTimeoutRef.current[id]) {
      clearTimeout(toastsTimeoutRef.current[id]);
      delete toastsTimeoutRef.current[id];
    }
    
    setToasts(currentToasts => currentToasts.filter(toast => toast.id !== id));
  };

  // Helper functions (moved up before they're used)
  // Get last response date from them (last REPLY message)
  const getLastResponseFromThem = (conversation) => {
    const replies = conversation.filter(msg => msg.type === 'REPLY');
    if (replies.length === 0) return null;
    return replies[replies.length - 1].time;
  };

  // Add utility functions at the top of the component
  const safeGetLastMessage = (lead) => {
    if (!lead?.conversation?.length) return null;
    return lead.conversation[lead.conversation.length - 1];
  };

  const timeDiff = (date1, date2) => {
    try {
      const d1 = new Date(date1);
      const d2 = new Date(date2);
      if (isNaN(d1.getTime()) || isNaN(d2.getTime())) return Infinity;
      return (d1 - d2) / (1000 * 60 * 60 * 24);
    } catch (e) {
      return Infinity;
    }
  };

  const getResponseUrgency = (lead) => {
    const lastMessage = safeGetLastMessage(lead);
    if (!lastMessage) return 'none';
    
    const isHighMediumIntent = lead.intent >= 4;
    const theyRepliedLast = lastMessage.type === 'REPLY';
    const weRepliedLast = lastMessage.type === 'SENT';
    const daysSinceLastMessage = timeDiff(new Date(), new Date(lastMessage.time));
    
    if (isHighMediumIntent && theyRepliedLast) {
      if (daysSinceLastMessage >= 2) return 'urgent-response';
      return 'needs-response';
    }
    
    if (weRepliedLast && daysSinceLastMessage >= 3) {
      return 'needs-followup';
    }
    
    return 'none';
  };

  // Fetch leads from Supabase with organization filtering
  useEffect(() => {
    if (organizationId) {
      fetchLeads();
    } else {
      setLoading(false);
      setError('No organization found for user. Please contact support.');
    }
  }, [organizationId]);

  const fetchLeads = async () => {
    try {
      setLoading(true);
      setError(null);
      
      // Query leads table with organization filtering
      const { data, error: supabaseError } = await supabase
        .from('leads')
        .select('*')
        .eq('organization_id', organizationId);
      
      if (supabaseError) {
        throw new Error(`Failed to fetch leads: ${supabaseError.message}`);
      }
      
      // Transform the data to match the expected format
      const transformedLeads = (data || []).map(lead => {
        // Parse conversation data from email_message_body and extract subject
        let conversation = [];
        let extractedSubject = `Campaign for ${lead.first_name || 'Lead'}`;
        let emailStatsId = null;
        
        try {
          if (lead.email_message_body) {
            const parsedConversation = JSON.parse(lead.email_message_body);
            
            // Extract stats_id from the first message
            if (parsedConversation.length > 0 && parsedConversation[0].stats_id) {
              emailStatsId = parsedConversation[0].stats_id;
            }
            
            conversation = parsedConversation.map((msg, index) => {
              const prevMsg = parsedConversation[index - 1];
              let responseTime = undefined;
              
              if (msg.type === 'REPLY' && prevMsg && prevMsg.type === 'SENT') {
                const timeDiff = new Date(msg.time) - new Date(prevMsg.time);
                responseTime = timeDiff / (1000 * 60 * 60); // Convert to hours
              }

              return {
                from: msg.from || '',
                to: msg.to || '',
                cc: msg.cc || null,
                type: msg.type || 'SENT',
                time: msg.time || new Date().toISOString(),
                content: extractTextFromHTML(msg.email_body || ''),
                subject: msg.subject || '',
                opened: (msg.open_count || 0) > 0,
                clicked: (msg.click_count || 0) > 0,
                response_time: responseTime
              };
            });
            
            // Extract subject from the first message in conversation or any message with subject
            if (conversation.length > 0) {
              const messageWithSubject = conversation.find(msg => msg.subject && msg.subject.trim() !== '');
              if (messageWithSubject) {
                extractedSubject = messageWithSubject.subject.trim();
              }
            }
          }
        } catch (e) {
          console.error('Error parsing conversation for lead', lead.id, e);
          conversation = [];
        }

        // Calculate metrics from conversation
        const replies = conversation.filter(m => m.type === 'REPLY');
        const sent = conversation.filter(m => m.type === 'SENT');
        
        // Calculate average response time
        const responseTimes = conversation
          .filter(m => m.response_time !== undefined)
          .map(m => m.response_time);
        const avgResponseTime = responseTimes.length > 0 
          ? responseTimes.reduce((sum, time) => sum + time, 0) / responseTimes.length 
          : 0;

        // Calculate engagement score
        let engagementScore = 0;
        if (sent.length > 0) {
          engagementScore += Math.min((replies.length / sent.length) * 60, 60);
          if (avgResponseTime < 1) engagementScore += 40;
          else if (avgResponseTime < 4) engagementScore += 30;
          else if (avgResponseTime < 24) engagementScore += 20;
          else if (avgResponseTime < 72) engagementScore += 10;
        }
        engagementScore = Math.round(Math.min(engagementScore, 100));

        // Calculate intent score based on conversation content
        const allText = conversation.map(m => m.content.toLowerCase()).join(' ');
        let intentScore = 1 + Math.min(replies.length * 2, 6);
        const positiveKeywords = ['interested', 'yes', 'sure', 'sounds good', 'let me know', 'call', 'meeting', 'schedule'];
        intentScore += positiveKeywords.filter(keyword => allText.includes(keyword)).length;
        if (allText.includes('price') || allText.includes('cost')) intentScore += 1;
        if (allText.includes('sample') || allText.includes('example')) intentScore += 1;
        intentScore = Math.min(intentScore, 10);

        return {
          id: lead.id,
          campaign_id: lead.campaign_id || lead.campaign_ID || null,
          lead_id: lead.lead_id || lead.lead_ID || null,
          email_stats_id: emailStatsId,
          created_at: lead.created_at,
          updated_at: lead.updated_at || lead.created_at,
          email: lead.email || lead.lead_email,
          first_name: lead.first_name || 'Unknown',
          last_name: lead.last_name || '',
          website: lead.website || lead.email?.split('@')[1] || lead.lead_email?.split('@')[1] || '',
          content_brief: lead.content_brief || `Email marketing campaign for ${lead.lead_category || 'business'}`,
          subject: extractedSubject,
          email_message_body: lead.email_message_body,
          intent: intentScore,
          created_at_best: lead.created_at,
          response_time_avg: avgResponseTime,
          engagement_score: engagementScore,
          lead_category: lead.lead_category,
          tags: [lead.lead_category ? leadCategoryMap[lead.lead_category] || 'Uncategorized' : 'Uncategorized'],
          conversation: conversation,
          // Include the Supabase fields with their values or defaults
          role: lead.role || 'N/A',
          company_data: lead.company_data || 'N/A',
          personal_linkedin_url: lead.personal_linkedin_url || null,
          business_linkedin_url: lead.business_linkedin_url || null,
          linkedin_url: lead.linkedin_url || 'N/A',
          phone: lead.phone || null,
          organization_id: lead.organization_id, // Include organization_id for consistency
          // Add any other relevant fields you want to include
        };
      });
      
      setLeads(transformedLeads);
    } catch (err) {
      console.error('Error fetching leads:', err);
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  // Helper function to extract text from HTML and clean reply content
  const extractTextFromHTML = (html) => {
    if (!html) return '';
    
    // First clean HTML tags and entities
    let text = html
      .replace(/<[^>]*>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&#39;/g, "'")
      .replace(/&#x27;/g, "'")
      .replace(/&apos;/g, "'")
      .replace(/&quot;/g, '"')
      .replace(/&#34;/g, '"')
      .replace(/&#x22;/g, '"')
      .replace(/&#8217;/g, "'")
      .replace(/&#8216;/g, "'")
      .replace(/&#8220;/g, '"')
      .replace(/&#8221;/g, '"')
      .replace(/&#8211;/g, '-')
      .replace(/&#8212;/g, '—')
      .replace(/&#8230;/g, '...')
      .replace(/&hellip;/g, '...')
      .replace(/&mdash;/g, '—')
      .replace(/&ndash;/g, '-')
      .replace(/&rsquo;/g, "'")
      .replace(/&lsquo;/g, "'")
      .replace(/&rdquo;/g, '"')
      .replace(/&ldquo;/g, '"')
      .replace(/\r\n/g, '\n')
      .replace(/\s+/g, ' ')
      .trim();
    
    // Extract only the new reply content (before common reply separators)
    const replyIndicators = [
      'On ', // "On [date], [person] wrote:"
      'From:', // "From: [email]"
      '-----Original Message-----',
      '________________________________',
      '--- On ',
      'Sent from my iPhone',
      'Sent from my iPad',
      'Get Outlook for',
      'This email was sent to'
    ];
    
    // Find the first occurrence of any reply indicator
    let cutoffIndex = text.length;
    replyIndicators.forEach(indicator => {
      const index = text.indexOf(indicator);
      if (index !== -1 && index < cutoffIndex) {
        cutoffIndex = index;
      }
    });
    
    // Also look for common quote patterns like "> "
    const lines = text.split('\n');
    let newReplyLines = [];
    
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      
      // Stop if we hit quoted content (lines starting with >)
      if (line.startsWith('>')) {
        break;
      }
      
      // Stop if we hit a reply indicator
      const hasReplyIndicator = replyIndicators.some(indicator => 
        line.includes(indicator)
      );
      if (hasReplyIndicator) {
        break;
      }
      
      newReplyLines.push(line);
    }
    
    // Use the shorter of the two methods
    const methodOne = text.substring(0, cutoffIndex).trim();
    const methodTwo = newReplyLines.join('\n').trim();
    
    const result = methodTwo.length > 0 && methodTwo.length < methodOne.length 
      ? methodTwo 
      : methodOne;
    
    return result || text; // Fallback to original if extraction fails
  };

  // Lead category mapping
  const leadCategoryMap = {
    1: 'Interested',
    2: 'Meeting Request', 
    3: 'Not Interested',
    4: 'Do Not Contact',
    5: 'Information Request',
    6: 'Out Of Office',
    7: 'Wrong Person',
    8: 'Uncategorizable by AI',
    9: 'Sender Originated Bounce'
  };



  // Available sort options
  const sortOptions = [
    { field: 'last_reply', label: 'Most Recent Lead Reply', getValue: (lead) => {
      const lastReply = getLastResponseFromThem(lead.conversation);
      return lastReply ? new Date(lastReply) : new Date(0);
    }},
    { field: 'last_sent', label: 'Most Recent Sent Message', getValue: (lead) => {
      const lastSent = lead.conversation.filter(m => m.type === 'SENT');
      return lastSent.length > 0 ? new Date(lastSent[lastSent.length - 1].time) : new Date(0);
    }},
    { field: 'intent', label: 'Intent Score', getValue: (lead) => lead.intent },
    { field: 'engagement', label: 'Engagement Score', getValue: (lead) => lead.engagement_score },
    { field: 'response_time', label: 'Response Time', getValue: (lead) => lead.response_time_avg },
    { field: 'name', label: 'Name (A-Z)', getValue: (lead) => `${lead.first_name} ${lead.last_name}`.toLowerCase() },
    { field: 'urgency', label: 'Urgency Level', getValue: (lead) => {
      const urgency = getResponseUrgency(lead);
      const urgencyOrder = { 'urgent-response': 4, 'needs-response': 3, 'needs-followup': 2, 'none': 1 };
      return urgencyOrder[urgency] || 0;
    }}
  ];

  // State for UI controls
  const [selectedLead, setSelectedLead] = useState(null);
  const [sortBy, setSortBy] = useState('recent');
  const [filterBy, setFilterBy] = useState('all');
  const [responseFilter, setResponseFilter] = useState('all');
  const [dateFilter, setDateFilter] = useState('all');
  const [customStartDate, setCustomStartDate] = useState('');
  const [customEndDate, setCustomEndDate] = useState('');
  const [industryFilter, setIndustryFilter] = useState('all');
  const [sourceFilter, setSourceFilter] = useState('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [draftResponse, setDraftResponse] = useState('');
  const [isGeneratingDraft, setIsGeneratingDraft] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [showMetrics, setShowMetrics] = useState(true);
  
  // Add state for collapsible sections - default to all open
  const [activeSection, setActiveSection] = useState(['general', 'enrichment', 'engagement']);
  
  // Analytics state
  const [analyticsDateRange, setAnalyticsDateRange] = useState('30'); // days
  
  // New state for editable email fields
  const [editableToEmail, setEditableToEmail] = useState('');
  const [editableCcEmails, setEditableCcEmails] = useState('');
  
  // New state for rich text editor
  const [showFormatting, setShowFormatting] = useState(false);
  const [selectedText, setSelectedText] = useState('');
  const [draftHtml, setDraftHtml] = useState('');
  
  // New state for advanced sort/filter popups
  const [showSortPopup, setShowSortPopup] = useState(false);
  const [showFilterPopup, setShowFilterPopup] = useState(false);
  const [activeSorts, setActiveSorts] = useState([{ field: 'last_reply', direction: 'desc' }]);
  const [activeFilters, setActiveFilters] = useState({});
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [leadToDelete, setLeadToDelete] = useState(null);
  const [showSentConfirm, setShowSentConfirm] = useState(false);

  // Available filter options
  const filterOptions = {
    intent: {
      label: 'Intent Score',
      options: [
        { value: 'high', label: 'High Intent (7-10)' },
        { value: 'medium', label: 'Medium Intent (4-6)' },
        { value: 'low', label: 'Low Intent (1-3)' }
      ]
    },
    urgency: {
      label: 'Urgency Status',
      options: [
        { value: 'urgent-response', label: '🚨 Urgent Response Needed' },
        { value: 'needs-response', label: '⚡ Needs Response' },
        { value: 'needs-followup', label: '📞 Needs Followup' },
        { value: 'none', label: 'No Action Needed' }
      ]
    },
    category: {
      label: 'Lead Category',
      options: [
        { value: '1', label: 'Interested' },
        { value: '2', label: 'Meeting Request' },
        { value: '3', label: 'Not Interested' },
        { value: '4', label: 'Do Not Contact' },
        { value: '5', label: 'Information Request' },
        { value: '6', label: 'Out Of Office' },
        { value: '7', label: 'Wrong Person' },
        { value: '8', label: 'Uncategorizable by AI' },
        { value: '9', label: 'Sender Originated Bounce' }
      ]
    },
    engagement: {
      label: 'Engagement Level',
      options: [
        { value: 'high', label: 'High Engagement (80%+)' },
        { value: 'medium', label: 'Medium Engagement (50-79%)' },
        { value: 'low', label: 'Low Engagement (0-49%)' }
      ]
    },
    replies: {
      label: 'Reply Status',
      options: [
        { value: 'has_replies', label: 'Has Replies' },
        { value: 'no_replies', label: 'No Replies Yet' },
        { value: 'multiple_replies', label: 'Multiple Replies (2+)' }
      ]
    },
    timeframe: {
      label: 'Last Activity',
      options: [
        { value: 'today', label: 'Today' },
        { value: 'yesterday', label: 'Yesterday' },
        { value: 'this_week', label: 'This Week' },
        { value: 'last_week', label: 'Last Week' },
        { value: 'this_month', label: 'This Month' },
        { value: 'older', label: 'Older than 1 Month' }
      ]
    }
  };

  // Handle adding sort
  const handleAddSort = (field, direction = 'desc') => {
    setActiveSorts(prev => {
      const existing = prev.find(s => s.field === field);
      if (existing) {
        return prev.map(s => s.field === field ? { ...s, direction } : s);
      }
      return [...prev, { field, direction }];
    });
  };

  // Handle removing sort
  const handleRemoveSort = (field) => {
    setActiveSorts(prev => prev.filter(s => s.field !== field));
    if (activeSorts.length === 1) {
      setActiveSorts([{ field: 'last_reply', direction: 'desc' }]); // Always have at least one sort
    }
  };

  // Handle adding filter with validation
  const handleAddFilter = (category, value) => {
    if (!category || !value || !filterOptions[category]) {
      console.warn('Invalid filter:', { category, value });
      return;
    }

    // Validate that the value exists in the options
    const isValidValue = filterOptions[category].options.some(opt => opt.value === value);
    if (!isValidValue) {
      console.warn('Invalid filter value:', { category, value });
      return;
    }

    setActiveFilters(prev => ({
      ...prev,
      [category]: [...new Set([...(prev[category] || []), value])]
    }));
  };

  // Handle removing filter with validation
  const handleRemoveFilter = (category, value) => {
    if (!category || !value || !activeFilters[category]) {
      console.warn('Invalid filter removal:', { category, value });
      return;
    }

    setActiveFilters(prev => {
      const updated = { ...prev };
      if (updated[category]) {
        updated[category] = updated[category].filter(v => v !== value);
        if (updated[category].length === 0) {
          delete updated[category];
        }
      }
      return updated;
    });
  };

  // Clear all filters
  const handleClearAllFilters = () => {
    setActiveFilters({});
    // Reset any related filter states
    setShowFilterPopup(false);
  };

  // Handle delete lead
  const handleDeleteLead = async (lead) => {
    try {
      console.log('Deleting lead:', lead);
      
      // Delete from Supabase database with organization validation
      const { error: deleteError } = await supabase
        .from('leads')
        .delete()
        .eq('id', lead.id)
        .eq('organization_id', organizationId); // Ensure user can only delete leads from their org
      
      if (deleteError) {
        throw new Error(`Failed to delete lead: ${deleteError.message}`);
      }

      console.log('Lead deleted successfully');
      
      // Remove from local state immediately for better UX
      setLeads(prevLeads => prevLeads.filter(l => l.id !== lead.id));
      
      // If this was the selected lead, clear selection
      if (selectedLead?.id === lead.id) {
        setSelectedLead(null);
      }
      
      // Close confirmation popup
      setShowDeleteConfirm(false);
      setLeadToDelete(null);
      
      showToast('Lead deleted successfully', 'success');
      
    } catch (error) {
      console.error('Error deleting lead:', error);
      showToast(`Error deleting lead: ${error.message}`, 'error');
      setShowDeleteConfirm(false);
      setLeadToDelete(null);
    }
  };

  // Show delete confirmation
  const showDeleteConfirmation = (lead) => {
    setLeadToDelete(lead);
    setShowDeleteConfirm(true);
  };
  const availableStages = [
    'initial-outreach',
    'engaged', 
    'pricing-discussion',
    'samples-requested',
    'call-scheduled',
    'considering',
    'stalled',
    'no-response',
    'rejected',
    'active'
  ];

  // Update lead stage
  const updateLeadStage = (leadId, newStage) => {
    setLeads(prevLeads => 
      prevLeads.map(lead => 
        lead.id === leadId 
          ? { ...lead, stage: newStage }
          : lead
      )
    );
  };

  // Calculate dashboard metrics
  const dashboardMetrics = useMemo(() => {
    const totalLeads = leads.length;
    const highIntentLeads = leads.filter(lead => lead.intent >= 7).length;
    const avgResponseTime = leads.reduce((sum, lead) => sum + lead.response_time_avg, 0) / totalLeads;
    const avgEngagement = leads.reduce((sum, lead) => sum + lead.engagement_score, 0) / totalLeads;
    
    const urgentResponse = leads.filter(lead => getResponseUrgency(lead) === 'urgent-response').length;
    const needsResponse = leads.filter(lead => getResponseUrgency(lead) === 'needs-response').length;
    const needsFollowup = leads.filter(lead => getResponseUrgency(lead) === 'needs-followup').length;

    return {
      totalLeads,
      highIntentLeads,
      avgResponseTime,
      avgEngagement,
      urgentResponse,
      needsResponse,
      needsFollowup
    };
  }, [leads]);

  // Message patterns for our outbound messages
  const MESSAGE_PATTERNS = {
    questions: ['?', 'what', 'how', 'when', 'where', 'why', 'could', 'would', 'interested', 'thoughts'],
    calls: ['call', 'meeting', 'schedule', 'discuss', 'chat', 'talk', 'meet', 'zoom', 'teams', 'connect'],
    pricing: ['price', 'cost', 'budget', 'investment', 'pricing', 'package', 'quote', 'plan', 'rate'],
    value_props: ['help', 'improve', 'increase', 'reduce', 'save', 'better', 'solution', 'roi', 'results', 'benefit']
  };

  // Calculate analytics data
  const analyticsData = useMemo(() => {
    if (!leads.length) return null;

    // Filter leads by date range
    const daysBack = parseInt(analyticsDateRange);
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - daysBack);
    
    const filteredLeads = leads.filter(lead => {
      const leadDate = new Date(lead.created_at);
      return leadDate >= cutoffDate;
    });

    // Analyze message content and patterns
    const messageAnalysis = filteredLeads.flatMap(lead => 
      lead.conversation
        .filter(msg => msg.type === 'SENT')
        .map(msg => {
          const content = msg.content.toLowerCase();
          const wordCount = content.split(/\s+/).length;
          
          // Check for pattern matches in our outbound messages
          const hasQuestion = MESSAGE_PATTERNS.questions.some(q => content.includes(q));
          const hasCall = MESSAGE_PATTERNS.calls.some(c => content.includes(c));
          const hasPricing = MESSAGE_PATTERNS.pricing.some(p => content.includes(p));
          const hasValueProp = MESSAGE_PATTERNS.value_props.some(v => content.includes(v));
          
          // Get next message if exists
          const msgIndex = lead.conversation.indexOf(msg);
          const nextMsg = lead.conversation[msgIndex + 1];
          const gotReply = nextMsg && nextMsg.type === 'REPLY';
          const replyTime = gotReply ? new Date(nextMsg.time) - new Date(msg.time) : null;
          
          return {
            wordCount,
            hasQuestion,
            hasCall,
            hasPricing,
            hasValueProp,
            gotReply,
            replyTime
          };
        })
    );

    // Calculate what works
    const copyInsights = {
      // Message length analysis
      totalMessages: messageAnalysis.length,
      avgWordCount: messageAnalysis.reduce((sum, m) => sum + m.wordCount, 0) / messageAnalysis.length,
      
      // Pattern success rates
             withQuestions: {
         total: messageAnalysis.filter(m => m.hasQuestion).length,
         success: messageAnalysis.filter(m => m.hasQuestion && m.gotReply).length
       },
       withCalls: {
         total: messageAnalysis.filter(m => m.hasCall).length,
         success: messageAnalysis.filter(m => m.hasCall && m.gotReply).length
       },
       withPricing: {
         total: messageAnalysis.filter(m => m.hasPricing).length,
         success: messageAnalysis.filter(m => m.hasPricing && m.gotReply).length
       },
       withValueProps: {
         total: messageAnalysis.filter(m => m.hasValueProp).length,
         success: messageAnalysis.filter(m => m.hasValueProp && m.gotReply).length
       },
      
      // Length effectiveness
      lengthBreakdown: [
        {
          range: '< 50 words',
          messages: messageAnalysis.filter(m => m.wordCount < 50).length,
          replies: messageAnalysis.filter(m => m.wordCount < 50 && m.gotReply).length
        },
        {
          range: '50-100 words',
          messages: messageAnalysis.filter(m => m.wordCount >= 50 && m.wordCount < 100).length,
          replies: messageAnalysis.filter(m => m.wordCount >= 50 && m.wordCount < 100 && m.gotReply).length
        },
        {
          range: '100-200 words',
          messages: messageAnalysis.filter(m => m.wordCount >= 100 && m.wordCount < 200).length,
          replies: messageAnalysis.filter(m => m.wordCount >= 100 && m.wordCount < 200 && m.gotReply).length
        },
        {
          range: '200+ words',
          messages: messageAnalysis.filter(m => m.wordCount >= 200).length,
          replies: messageAnalysis.filter(m => m.wordCount >= 200 && m.gotReply).length
        }
      ],
      
      // Response time by pattern
      avgReplyTime: {
        withQuestion: messageAnalysis.filter(m => m.hasQuestion && m.replyTime).reduce((sum, m) => sum + m.replyTime, 0) / 
                     messageAnalysis.filter(m => m.hasQuestion && m.replyTime).length / (1000 * 60 * 60), // Convert to hours
        withCall: messageAnalysis.filter(m => m.hasCall && m.replyTime).reduce((sum, m) => sum + m.replyTime, 0) /
                 messageAnalysis.filter(m => m.hasCall && m.replyTime).length / (1000 * 60 * 60),
        withPricing: messageAnalysis.filter(m => m.hasPricing && m.replyTime).reduce((sum, m) => sum + m.replyTime, 0) /
                    messageAnalysis.filter(m => m.hasPricing && m.replyTime).length / (1000 * 60 * 60),
        withValueProp: messageAnalysis.filter(m => m.hasValueProp && m.replyTime).reduce((sum, m) => sum + m.replyTime, 0) /
                      messageAnalysis.filter(m => m.hasValueProp && m.replyTime).length / (1000 * 60 * 60)
      }
    };

    // Overall metrics (meaningful for response inbox)
    const totalLeads = filteredLeads.length;
    const leadsWithMultipleReplies = filteredLeads.filter(lead => 
      lead.conversation.filter(msg => msg.type === 'REPLY').length >= 2
    ).length;
    const engagementRate = totalLeads > 0 ? (leadsWithMultipleReplies / totalLeads * 100) : 0;
    
    // Average replies per lead (more meaningful than response rate)
    const totalReplies = filteredLeads.reduce((sum, lead) => 
      sum + lead.conversation.filter(msg => msg.type === 'REPLY').length, 0
    );
    const avgRepliesPerLead = totalLeads > 0 ? (totalReplies / totalLeads) : 0;

    // Response time analysis
    const responseTimesByLead = filteredLeads.map(lead => lead.response_time_avg).filter(time => time > 0);
    const avgResponseTime = responseTimesByLead.length > 0 
      ? responseTimesByLead.reduce((sum, time) => sum + time, 0) / responseTimesByLead.length 
      : 0;

    // Response time distribution
    const responseTimeDistribution = {
      under1h: responseTimesByLead.filter(time => time < 1).length,
      '1to4h': responseTimesByLead.filter(time => time >= 1 && time < 4).length,
      '4to24h': responseTimesByLead.filter(time => time >= 4 && time < 24).length,
      over24h: responseTimesByLead.filter(time => time >= 24).length
    };

    // Campaign performance (meaningful metrics for response inbox)
    const campaignPerformance = filteredLeads.reduce((acc, lead) => {
      const campaignId = lead.campaign_id || 'Unknown Campaign';
      if (!acc[campaignId]) {
        acc[campaignId] = {
          name: `Campaign ${campaignId}`,
          totalLeads: 0,
          totalReplies: 0,
          totalIntent: 0,
          totalEngagement: 0,
          responseTimes: [],
          conversationDepths: []
        };
      }
      
      acc[campaignId].totalLeads++;
      acc[campaignId].totalIntent += lead.intent;
      acc[campaignId].totalEngagement += lead.engagement_score;
      
      const replyCount = lead.conversation.filter(msg => msg.type === 'REPLY').length;
      acc[campaignId].totalReplies += replyCount;
      acc[campaignId].conversationDepths.push(lead.conversation.length);
      
      if (lead.response_time_avg > 0) {
        acc[campaignId].responseTimes.push(lead.response_time_avg);
      }
      
      return acc;
    }, {});

    // Calculate campaign averages and sort by engagement score
    const campaignStats = Object.values(campaignPerformance)
      .map(campaign => ({
        ...campaign,
        avgRepliesPerLead: campaign.totalLeads > 0 ? (campaign.totalReplies / campaign.totalLeads) : 0,
        avgIntent: campaign.totalLeads > 0 ? (campaign.totalIntent / campaign.totalLeads) : 0,
        avgEngagement: campaign.totalLeads > 0 ? (campaign.totalEngagement / campaign.totalLeads) : 0,
        avgResponseTime: campaign.responseTimes.length > 0 
          ? campaign.responseTimes.reduce((sum, time) => sum + time, 0) / campaign.responseTimes.length 
          : 0,
        avgConversationDepth: campaign.conversationDepths.length > 0
          ? campaign.conversationDepths.reduce((sum, depth) => sum + depth, 0) / campaign.conversationDepths.length
          : 0
      }))
      .sort((a, b) => b.avgEngagement - a.avgEngagement);

    // Lead category performance (meaningful metrics for response inbox)
    const categoryPerformance = filteredLeads.reduce((acc, lead) => {
      const category = lead.tags && lead.tags[0] ? lead.tags[0] : 'Uncategorized';
      if (!acc[category]) {
        acc[category] = { 
          totalLeads: 0, 
          totalReplies: 0, 
          totalEngagement: 0,
          responseTimes: [],
          conversationDepths: []
        };
      }
      
      acc[category].totalLeads++;
      acc[category].totalReplies += lead.conversation.filter(msg => msg.type === 'REPLY').length;
      acc[category].totalEngagement += lead.engagement_score;
      acc[category].conversationDepths.push(lead.conversation.length);
      
      if (lead.response_time_avg > 0) {
        acc[category].responseTimes.push(lead.response_time_avg);
      }
      
      return acc;
    }, {});

    const categoryStats = Object.entries(categoryPerformance)
      .map(([category, data]) => ({
        category,
        totalLeads: data.totalLeads,
        avgRepliesPerLead: data.totalLeads > 0 ? (data.totalReplies / data.totalLeads) : 0,
        avgEngagement: data.totalLeads > 0 ? (data.totalEngagement / data.totalLeads) : 0,
        avgResponseTime: data.responseTimes.length > 0
          ? data.responseTimes.reduce((sum, time) => sum + time, 0) / data.responseTimes.length
          : 0,
        avgConversationDepth: data.conversationDepths.length > 0
          ? data.conversationDepths.reduce((sum, depth) => sum + depth, 0) / data.conversationDepths.length
          : 0
      }))
      .sort((a, b) => b.avgEngagement - a.avgEngagement);

    // Intent vs Engagement correlation (more meaningful than response rate)
    const intentCorrelation = [
      { intent: 'High (7-10)', 
        avgReplies: filteredLeads.filter(l => l.intent >= 7).length > 0
          ? filteredLeads.filter(l => l.intent >= 7)
              .reduce((sum, l) => sum + l.conversation.filter(m => m.type === 'REPLY').length, 0) / 
            filteredLeads.filter(l => l.intent >= 7).length : 0,
        count: filteredLeads.filter(l => l.intent >= 7).length },
      { intent: 'Medium (4-6)', 
        avgReplies: filteredLeads.filter(l => l.intent >= 4 && l.intent < 7).length > 0
          ? filteredLeads.filter(l => l.intent >= 4 && l.intent < 7)
              .reduce((sum, l) => sum + l.conversation.filter(m => m.type === 'REPLY').length, 0) / 
            filteredLeads.filter(l => l.intent >= 4 && l.intent < 7).length : 0,
        count: filteredLeads.filter(l => l.intent >= 4 && l.intent < 7).length },
      { intent: 'Low (1-3)', 
        avgReplies: filteredLeads.filter(l => l.intent < 4).length > 0
          ? filteredLeads.filter(l => l.intent < 4)
              .reduce((sum, l) => sum + l.conversation.filter(m => m.type === 'REPLY').length, 0) / 
            filteredLeads.filter(l => l.intent < 4).length : 0,
        count: filteredLeads.filter(l => l.intent < 4).length }
    ];

    // Time/Day heatmap analysis
    const replyMessages = filteredLeads.flatMap(lead => 
      lead.conversation.filter(msg => msg.type === 'REPLY')
        .map(msg => ({
          ...msg,
          date: new Date(msg.time),
          hour: new Date(msg.time).getHours(),
          dayOfWeek: new Date(msg.time).getDay() // 0=Sunday, 1=Monday, etc
        }))
    );

    // Create heatmap data structure
    const heatmapData = Array.from({ length: 7 }, (_, day) => 
      Array.from({ length: 24 }, (_, hour) => ({
        day,
        hour,
        count: replyMessages.filter(msg => msg.dayOfWeek === day && msg.hour === hour).length,
        dayName: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][day]
      }))
    ).flat();

    // Peak activity times
    const maxCount = Math.max(...heatmapData.map(d => d.count));
    const peakHour = heatmapData.find(d => d.count === maxCount);

    // Response trends (daily) - showing engagement trends instead
    const last30Days = Array.from({ length: Math.min(daysBack, 30) }, (_, i) => {
      const date = new Date();
      date.setDate(date.getDate() - i);
      return date.toISOString().split('T')[0];
    }).reverse();

    const responseTrends = last30Days.map(dateStr => {
      const dayReplies = replyMessages.filter(msg => 
        msg.time.split('T')[0] === dateStr
      );
      
      return {
        date: dateStr,
        replyCount: dayReplies.length,
        avgResponseTime: dayReplies.length > 0 
          ? dayReplies.reduce((sum, msg) => sum + (msg.response_time || 0), 0) / dayReplies.length 
          : 0
      };
    });

          return {
      totalLeads,
      leadsWithMultipleReplies,
      engagementRate,
      avgRepliesPerLead,
      avgResponseTime,
      responseTimeDistribution,
      campaignStats: campaignStats.slice(0, 10), // Top 10 campaigns
      categoryStats,
      intentCorrelation,
      responseTrends,
      heatmapData,
      peakHour,
      maxCount,
      totalReplies,
      dateRange: daysBack,
      copyInsights // Add copy insights to analytics data
    };
  }, [leads, analyticsDateRange]);

  // Get intent color and label - NO COLORS, only for circles
  const getIntentStyle = (intent) => {
    return { bg: '', border: '', text: 'text-white', label: intent >= 7 ? 'High Intent' : intent >= 4 ? 'Medium Intent' : 'Low Intent' };
  };

  // Get engagement color
  const getEngagementColor = (score) => {
    if (score >= 90) return 'text-green-600';
    if (score >= 75) return 'text-yellow-600';
    return 'text-red-600';
  };

  // Enhanced filter and sort leads
  const filteredAndSortedLeads = useMemo(() => {
    try {
      if (!leads || !Array.isArray(leads)) {
        return [];
      }
      let filtered = leads.slice(); // Create a copy

      // Apply tab filter first
      if (activeTab === 'need_response') {
        filtered = filtered.filter(lead => {
          try {
            if (!lead || !lead.conversation || !Array.isArray(lead.conversation) || lead.conversation.length === 0) {
              return false;
            }
            const lastMessage = lead.conversation[lead.conversation.length - 1];
            return lastMessage && lastMessage.type === 'REPLY';
          } catch (e) {
            console.warn('Error filtering need_response:', e);
            return false;
          }
        });
      } else if (activeTab === 'recently_sent') {
        filtered = filtered.filter(lead => {
          try {
            if (!lead || !lead.conversation || !Array.isArray(lead.conversation) || lead.conversation.length === 0) {
              return false;
            }
            const lastMessage = lead.conversation[lead.conversation.length - 1];
            if (!lastMessage || !lastMessage.time || lastMessage.type !== 'SENT') {
              return false;
            }
            const timeSinceLastMessage = Math.floor((new Date() - new Date(lastMessage.time)) / (1000 * 60 * 60));
            return timeSinceLastMessage <= 24;
          } catch (e) {
            console.warn('Error filtering recently_sent:', e);
            return false;
          }
        });
      }

      // Apply search filter
      if (searchQuery && typeof searchQuery === 'string' && searchQuery.trim()) {
        const query = searchQuery.toLowerCase().trim();
        filtered = filtered.filter(lead => {
          try {
            if (!lead) return false;
            
            const firstName = (lead.first_name || '').toLowerCase();
            const lastName = (lead.last_name || '').toLowerCase();
            const email = (lead.email || '').toLowerCase();
            const subject = (lead.subject || '').toLowerCase();
            
            let tagsMatch = false;
            if (lead.tags && Array.isArray(lead.tags)) {
              tagsMatch = lead.tags.some(tag => {
                return tag && typeof tag === 'string' && tag.toLowerCase().includes(query);
              });
            }
            
            return firstName.includes(query) || 
                   lastName.includes(query) || 
                   email.includes(query) || 
                   subject.includes(query) || 
                   tagsMatch;
          } catch (e) {
            console.warn('Error in search filter:', e);
            return false;
          }
        });
      }

      // Apply advanced filters
      if (activeFilters && typeof activeFilters === 'object') {
        for (const [category, values] of Object.entries(activeFilters)) {
          if (!values || !Array.isArray(values) || values.length === 0) continue;
          
          filtered = filtered.filter(lead => {
            try {
              if (!lead) return false;
              
              return values.some(value => {
                if (!value) return false;
                
                switch (category) {
                  case 'intent':
                    if (typeof lead.intent !== 'number') return false;
                    if (value === 'high') return lead.intent >= 7;
                    if (value === 'medium') return lead.intent >= 4 && lead.intent <= 6;
                    if (value === 'low') return lead.intent <= 3;
                    return false;
                  
                  case 'urgency':
                    try {
                      const urgency = getResponseUrgency(lead);
                      return value === urgency;
                    } catch (e) {
                      console.warn('Error checking urgency:', e);
                      return false;
                    }
                  
                  case 'category':
                    return lead.lead_category && lead.lead_category.toString() === value;
                  
                  case 'engagement':
                    if (typeof lead.engagement_score !== 'number') return false;
                    if (value === 'high') return lead.engagement_score >= 80;
                    if (value === 'medium') return lead.engagement_score >= 50 && lead.engagement_score < 80;
                    if (value === 'low') return lead.engagement_score < 50;
                    return false;
                  
                  case 'replies':
                    try {
                      let replyCount = 0;
                      if (lead.conversation && Array.isArray(lead.conversation)) {
                        replyCount = lead.conversation.filter(m => m && m.type === 'REPLY').length;
                      }
                      if (value === 'has_replies') return replyCount > 0;
                      if (value === 'no_replies') return replyCount === 0;
                      if (value === 'multiple_replies') return replyCount >= 2;
                      return false;
                    } catch (e) {
                      console.warn('Error checking replies:', e);
                      return false;
                    }
                  
                  case 'timeframe':
                    try {
                      let lastActivity;
                      if (lead.conversation && Array.isArray(lead.conversation) && lead.conversation.length > 0) {
                        const lastMessage = lead.conversation[lead.conversation.length - 1];
                        lastActivity = lastMessage && lastMessage.time ? new Date(lastMessage.time) : new Date(lead.created_at || Date.now());
                      } else {
                        lastActivity = new Date(lead.created_at || Date.now());
                      }
                      
                      const daysDiff = (new Date() - lastActivity) / (1000 * 60 * 60 * 24);
                      
                      if (value === 'today') return daysDiff >= 0 && daysDiff < 1;
                      if (value === 'yesterday') return daysDiff >= 1 && daysDiff < 2;
                      if (value === 'this_week') return daysDiff <= 7;
                      if (value === 'last_week') return daysDiff > 7 && daysDiff <= 14;
                      if (value === 'this_month') return daysDiff <= 30;
                      if (value === 'older') return daysDiff > 30;
                      return false;
                    } catch (e) {
                      console.warn('Error checking timeframe:', e);
                      return false;
                    }
                  
                  default:
                    return false;
                }
              });
            } catch (e) {
              console.warn('Error in advanced filter:', e);
              return false;
            }
          });
        }
      }

      return filtered;
    } catch (e) {
      console.error('Error in filteredAndSortedLeads:', e);
      return leads || [];
    }
  }, [leads, searchQuery, activeFilters, activeTab]);

  // Auto-populate email fields and restore drafts when lead is selected
  useEffect(() => {
    if (selectedLead) {
      // Add to recently viewed
      addToRecentlyViewed(selectedLead);
      
      // Restore draft if exists
      const savedDraft = drafts[selectedLead.id];
      if (savedDraft) {
        setDraftResponse(savedDraft.content);
        setDraftHtml(savedDraft.htmlContent || '');
        const editor = document.querySelector('[contenteditable]');
        if (editor) {
          editor.innerHTML = savedDraft.htmlContent || savedDraft.content.replace(/\n/g, '<br>');
        }
      } else {
        // Clear draft if no saved content
        setDraftResponse('');
        setDraftHtml('');
        const editor = document.querySelector('[contenteditable]');
        if (editor) {
          editor.innerHTML = '';
        }
      }
      
      if (selectedLead.conversation.length > 0) {
        const lastMessage = selectedLead.conversation[selectedLead.conversation.length - 1];
        
        // Dynamically detect our email addresses from SENT messages
        const getOurEmails = () => {
          const ourEmails = new Set();
          selectedLead.conversation.forEach(msg => {
            if (msg.type === 'SENT' && msg.from) {
              ourEmails.add(msg.from);
            }
          });
          return Array.from(ourEmails);
        };
        
        // Get all unique email participants from the conversation (excluding our emails)
        const getAllParticipants = () => {
          const participants = new Set();
          const ourEmails = getOurEmails();
          
          // Go through conversation to find all unique email addresses
          selectedLead.conversation.forEach(msg => {
            if (msg.from) participants.add(msg.from);
            if (msg.to) participants.add(msg.to);
            if (msg.cc && Array.isArray(msg.cc) && msg.cc.length > 0) {
              msg.cc.forEach(ccEntry => {
                if (ccEntry.address) participants.add(ccEntry.address);
              });
            }
          });
          
          // Remove our own emails dynamically
          ourEmails.forEach(email => participants.delete(email));
          
          return Array.from(participants);
        };
        
        // Determine recipients based on the last message
        let primaryRecipient = '';
        let ccRecipients = [];
        
        if (lastMessage.type === 'REPLY') {
          // If they replied, send back to the sender and CC everyone else who was involved
          primaryRecipient = lastMessage.from;
          
          // Get all other participants for CC (excluding the primary recipient)
          const allParticipants = getAllParticipants();
          ccRecipients = allParticipants.filter(email => email !== primaryRecipient);
        } else {
          // If we sent last, use the same recipients as the last sent message
          primaryRecipient = lastMessage.to || selectedLead.email;
          
          // Only add CC if the last message actually had CC recipients
          if (lastMessage.cc && Array.isArray(lastMessage.cc) && lastMessage.cc.length > 0) {
            ccRecipients = lastMessage.cc
              .map(cc => cc.address)
              .filter(email => email && email.trim() !== '');
          }
        }
        
        setEditableToEmail(primaryRecipient || selectedLead.email);
        setEditableCcEmails(ccRecipients.join(', '));
      } else {
        // Fallback to original lead email if no conversation
        setEditableToEmail(selectedLead.email);
        setEditableCcEmails('');
      }
    }
  }, [selectedLead]);
  const calculateEngagementScore = (conversation) => {
    const replies = conversation.filter(m => m.type === 'REPLY').length;
    const sent = conversation.filter(m => m.type === 'SENT').length;
    if (sent === 0) return 0;
    
    let score = 0;
    
    // Response rate (60 points max)
    score += Math.min((replies / sent) * 60, 60);
    
    // Response speed bonus (40 points max)
    const avgResponse = conversation
      .filter(m => m.response_time)
      .reduce((sum, m) => sum + m.response_time, 0) / Math.max(replies, 1);
    
    if (avgResponse < 1) score += 40;      // Under 1 hour = 40 points
    else if (avgResponse < 4) score += 30;  // Under 4 hours = 30 points  
    else if (avgResponse < 24) score += 20; // Under 1 day = 20 points
    else if (avgResponse < 72) score += 10; // Under 3 days = 10 points
    
    return Math.round(Math.min(score, 100));
  };

  // Check if lead needs reply (they replied last)
  const checkNeedsReply = (conversation) => {
    if (!conversation || conversation.length === 0) return false;
    const lastMessage = conversation[conversation.length - 1];
    return lastMessage && lastMessage.type === 'REPLY';
  };

  // Auto-generate tags based on conversation - DISABLED
  const generateAutoTags = (conversation, lead) => {
    // Only return the lead category tag
    return lead.tags || [];
  };

  // Detect conversation stage
  const detectConversationStage = (conversation) => {
    const allText = conversation.map(m => m.content.toLowerCase()).join(' ');
    const replies = conversation.filter(m => m.type === 'REPLY');
    const lastMessage = conversation[conversation.length - 1];
    const daysSinceLastMessage = (new Date() - new Date(lastMessage.time)) / (1000 * 60 * 60 * 24);
    
    // No replies yet
    if (replies.length === 0) {
      if (daysSinceLastMessage > 7) return 'no-response';
      return 'initial-outreach';
    }
    
    // Has replies - analyze content and timing
    if (allText.includes('not interested') || allText.includes('no thanks')) {
      return 'rejected';
    }
    
    if (allText.includes('price') || allText.includes('cost') || allText.includes('budget')) {
      return 'pricing-discussion';
    }
    
    if (allText.includes('sample') || allText.includes('example') || allText.includes('portfolio')) {
      return 'samples-requested';
    }
    
    if (allText.includes('call') || allText.includes('meeting') || allText.includes('schedule')) {
      return 'call-scheduled';
    }
    
    if (allText.includes('think about') || allText.includes('discuss with team') || allText.includes('get back')) {
      return 'considering';
    }
    
    // Check for stalled conversations
    if (daysSinceLastMessage > 7) {
      return 'stalled';
    }
    
    // Active conversation with positive engagement
    if (replies.length > 0 && (allText.includes('interested') || allText.includes('yes') || allText.includes('sure'))) {
      return 'engaged';
    }
    
    return 'active';
  };

  // Get stage styling
  const getStageStyle = (stage) => {
    const styles = {
      'initial-outreach': { bg: 'bg-blue-100', text: 'text-blue-800', label: 'Initial Outreach' },
      'engaged': { bg: 'bg-green-100', text: 'text-green-800', label: 'Engaged' },
      'pricing-discussion': { bg: 'bg-purple-100', text: 'text-purple-800', label: 'Pricing Discussion' },
      'samples-requested': { bg: 'bg-orange-100', text: 'text-orange-800', label: 'Samples Requested' },
      'call-scheduled': { bg: 'bg-cyan-100', text: 'text-cyan-800', label: 'Call Scheduled' },
      'considering': { bg: 'bg-yellow-100', text: 'text-yellow-800', label: 'Considering' },
      'stalled': { bg: 'bg-red-100', text: 'text-red-800', label: 'Stalled' },
      'no-response': { bg: 'bg-gray-100', text: 'text-gray-800', label: 'No Response' },
      'rejected': { bg: 'bg-red-100', text: 'text-red-800', label: 'Rejected' },
      'active': { bg: 'bg-blue-100', text: 'text-blue-800', label: 'Active' }
    };
    return styles[stage] || styles['active'];
  };

  // Format timestamp
  const formatTime = (timestamp) => {
    return new Date(timestamp).toLocaleString();
  };

  // Format currency
  const formatCurrency = (amount) => {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(amount);
  };

  // Rich text formatting functions
  const formatText = (command, value = null) => {
    document.execCommand(command, false, value);
  };

  const insertLink = () => {
    const selection = window.getSelection();
    const selectedText = selection.toString().trim();
    const range = selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
    const editor = document.querySelector('[contenteditable]');

    // Create modal with clean styling
    const modal = document.createElement('div');
    modal.style.cssText = `
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: rgba(0, 0, 0, 0.5);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 1000;
    `;
    
    const content = document.createElement('div');
    content.style.cssText = `
      background: #1A1C1A;
      border: 1px solid rgba(255, 255, 255, 0.2);
      border-radius: 8px;
      padding: 24px;
      width: 400px;
      max-width: 90vw;
    `;

    // Title
    const title = document.createElement('h3');
    title.textContent = 'Insert Link';
    title.style.cssText = `
      color: white;
      font-weight: bold;
      margin: 0 0 20px 0;
      font-size: 16px;
    `;

    // Text input
    const textContainer = document.createElement('div');
    textContainer.style.marginBottom = '16px';
    
    const textLabel = document.createElement('label');
    textLabel.textContent = 'Text to display:';
    textLabel.style.cssText = `
      display: block;
      color: white;
      font-size: 12px;
      margin-bottom: 4px;
    `;

    const textInput = document.createElement('input');
    textInput.type = 'text';
    textInput.value = selectedText;
    textInput.placeholder = 'Link text';
    textInput.style.cssText = `
          width: 100%;
          padding: 8px 12px;
          border: 1px solid rgba(255, 255, 255, 0.2);
          border-radius: 6px;
          background: rgba(255, 255, 255, 0.05);
          color: white;
      font-size: 14px;
      box-sizing: border-box;
      outline: none;
    `;

    // URL input
    const urlContainer = document.createElement('div');
    urlContainer.style.marginBottom = '24px';
    
    const urlLabel = document.createElement('label');
    urlLabel.textContent = 'URL:';
    urlLabel.style.cssText = textLabel.style.cssText;

    const urlInput = document.createElement('input');
    urlInput.type = 'text';
    urlInput.placeholder = 'https://example.com';
    urlInput.style.cssText = textInput.style.cssText;

    // Error message
    const errorMessage = document.createElement('div');
    errorMessage.style.cssText = `
      color: #ff4444;
      font-size: 12px;
          margin-bottom: 16px;
      min-height: 16px;
    `;

    // Buttons
    const buttonsContainer = document.createElement('div');
    buttonsContainer.style.cssText = `
      display: flex;
      justify-content: flex-end;
      gap: 8px;
    `;

    const cancelButton = document.createElement('button');
    cancelButton.textContent = 'Cancel';
    cancelButton.style.cssText = `
            padding: 8px 16px;
            border: 1px solid rgba(255, 255, 255, 0.2);
            border-radius: 6px;
            background: rgba(255, 255, 255, 0.05);
            color: white;
            cursor: pointer;
      font-size: 14px;
    `;

    const insertButton = document.createElement('button');
    insertButton.textContent = 'Insert Link';
    insertButton.style.cssText = `
            padding: 8px 16px;
            border: none;
            border-radius: 6px;
            background: #54FCFF;
            color: #1A1C1A;
            cursor: pointer;
            font-weight: bold;
      font-size: 14px;
    `;

    // Assemble the modal
    textContainer.appendChild(textLabel);
    textContainer.appendChild(textInput);
    urlContainer.appendChild(urlLabel);
    urlContainer.appendChild(urlInput);
    buttonsContainer.appendChild(cancelButton);
    buttonsContainer.appendChild(insertButton);

    content.appendChild(title);
    content.appendChild(textContainer);
    content.appendChild(urlContainer);
    content.appendChild(errorMessage);
    content.appendChild(buttonsContainer);
    modal.appendChild(content);

    document.body.appendChild(modal);

    // Focus URL input if text is selected, otherwise focus text input
    setTimeout(() => {
      if (selectedText) {
    urlInput.focus();
      } else {
        textInput.focus();
      }
    }, 50);

    const validateAndInsert = () => {
      const text = textInput.value.trim();
      let url = urlInput.value.trim();

      // Validate inputs
      if (!text) {
        errorMessage.textContent = 'Please enter the text to display';
        return;
      }

      if (!url) {
        errorMessage.textContent = 'Please enter a URL';
        return;
      }

      // Add protocol if missing
      if (!url.startsWith('http://') && !url.startsWith('https://')) {
        url = 'https://' + url;
      }

      // Validate URL format
      try {
        new URL(url);
      } catch (e) {
        errorMessage.textContent = 'Please enter a valid URL';
        return;
      }

      if (range && editor) {
        // Create link wrapper div to help with positioning the remove button
        const linkWrapper = document.createElement('span');
        linkWrapper.style.position = 'relative';
        linkWrapper.style.display = 'inline-block';
        
        // Create the link
        const link = document.createElement('a');
        link.href = url;
        link.textContent = text;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.style.cssText = `
          color: #0066cc;
          text-decoration: underline;
          cursor: pointer;
        `;
        
        // Create remove button (always visible)
        const removeBtn = document.createElement('span');
        removeBtn.textContent = '×';
        removeBtn.style.cssText = `
          position: absolute;
          top: -8px;
          right: -12px;
          background: #e0e0e0;
          color: #333;
          border-radius: 50%;
          width: 16px;
          height: 16px;
          font-size: 12px;
          line-height: 16px;
          text-align: center;
          cursor: pointer;
          user-select: none;
          opacity: 0;
          transition: opacity 0.2s;
        `;
        
        // Show/hide remove button on hover
        linkWrapper.addEventListener('mouseenter', () => {
          removeBtn.style.opacity = '1';
          link.style.color = '#004499';
        });
        
        linkWrapper.addEventListener('mouseleave', () => {
          removeBtn.style.opacity = '0';
          link.style.color = '#0066cc';
        });
        
        // Handle remove button click
        removeBtn.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          const text = document.createTextNode(link.textContent);
          linkWrapper.parentNode.replaceChild(text, linkWrapper);
          handleTextareaChange({ target: editor });
        });
        
        // Assemble the link component
        linkWrapper.appendChild(link);
        linkWrapper.appendChild(removeBtn);
        
        // Insert into document
        range.deleteContents();
        range.insertNode(linkWrapper);
        
        // Update editor content
        handleTextareaChange({ target: editor });
      }

      // Close modal
      document.body.removeChild(modal);
    };
    
    // Event Listeners
    cancelButton.addEventListener('click', () => document.body.removeChild(modal));
    insertButton.addEventListener('click', validateAndInsert);
    
    // Handle Enter key
    [textInput, urlInput].forEach(input => {
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          validateAndInsert();
        }
      });
    });

    // Close on background click
    modal.addEventListener('click', (e) => {
      if (e.target === modal) {
      document.body.removeChild(modal);
      }
    });

    // Handle Escape key
    document.addEventListener('keydown', function escapeHandler(e) {
      if (e.key === 'Escape') {
        document.body.removeChild(modal);
        document.removeEventListener('keydown', escapeHandler);
      }
    });
  };

  const insertList = () => {
    const editor = document.querySelector('[contenteditable]');
    const selection = window.getSelection();
    
    if (selection.rangeCount > 0) {
      const range = selection.getRangeAt(0);
      const selectedText = selection.toString().trim();
      
      if (selectedText) {
        // Convert selected text into a formatted list
        const lines = selectedText.split('\n');
        const listContainer = document.createElement('div');
        listContainer.style.cssText = `
          margin: 8px 0;
          padding-left: 8px;
        `;
        
        lines
          .map(line => line.trim())
          .filter(line => line.length > 0)
          .forEach(line => {
            const listItem = document.createElement('div');
            listItem.style.cssText = `
              position: relative;
              padding-left: 20px;
              margin: 4px 0;
              line-height: 1.5;
            `;
            
            // Create bullet point
            const bullet = document.createElement('span');
            bullet.textContent = '•';
            bullet.style.cssText = `
              position: absolute;
              left: 4px;
              font-size: 1.2em;
              line-height: 1;
              top: 50%;
              transform: translateY(-50%);
            `;
            
            // Create text content without explicit color
            const textContent = document.createElement('span');
            textContent.textContent = line;
            
            listItem.appendChild(bullet);
            listItem.appendChild(textContent);
            listContainer.appendChild(listItem);
          });
        
        // Insert the formatted list
      range.deleteContents();
        range.insertNode(listContainer);
      } else {
        // Insert a single formatted bullet point
        const listItem = document.createElement('div');
        listItem.style.cssText = `
          position: relative;
          padding-left: 20px;
          margin: 4px 0;
          line-height: 1.5;
        `;
        
        // Create bullet point
        const bullet = document.createElement('span');
        bullet.textContent = '•';
        bullet.style.cssText = `
          position: absolute;
          left: 4px;
          font-size: 1.2em;
          line-height: 1;
          top: 50%;
          transform: translateY(-50%);
        `;
        
        // Create editable content area without explicit color
        const textContent = document.createElement('span');
        
        listItem.appendChild(bullet);
        listItem.appendChild(textContent);
        
        // Insert at cursor position
        range.deleteContents();
        range.insertNode(listItem);
        
        // Move cursor to text content
        const newRange = document.createRange();
        newRange.setStart(textContent, 0);
        newRange.collapse(true);
        selection.removeAllRanges();
        selection.addRange(newRange);
      }
      
      // Update the draft content
      handleTextareaChange({ target: editor });
    }
  };

  const handleTextareaChange = (e) => {
    // Clean up any remaining remove buttons
    const removeButtons = e.target.querySelectorAll('.remove-link');
    removeButtons.forEach(btn => btn.remove());
    
    // Sanitize HTML content to prevent XSS attacks
    const rawHtml = e.target.innerHTML;
    const sanitizedHtml = sanitizeHtml(rawHtml);
    
    // Update content with sanitized HTML
    const textContent = e.target.textContent || e.target.innerText;
    setDraftResponse(textContent);
    setDraftHtml(sanitizedHtml);
    
    // Auto-save draft if we have a selected lead
    if (selectedLead) {
      saveDraft(selectedLead.id, textContent, sanitizedHtml);
    }
    
    // Update the editor with sanitized content if it was changed
    if (rawHtml !== sanitizedHtml) {
      e.target.innerHTML = sanitizedHtml;
      console.warn('HTML content was sanitized for security');
    }
  };

  const convertToHtml = (text) => {
    return text.replace(/\n/g, '<br>');
  };
  const formatResponseTime = (hours) => {
    if (hours < 1) return `${Math.round(hours * 60)}m`;
    if (hours < 24) return `${hours.toFixed(1)}h`;
    return `${(hours / 24).toFixed(1)}d`;
  };

  // Handle draft generation
  const generateDraft = async () => {
    if (!selectedLead) {
      console.error('No lead selected');
      return;
    }

    setIsGeneratingDraft(true);
    console.log('Generating draft for lead:', selectedLead);
    
    try {
      const lastMessage = selectedLead.conversation[selectedLead.conversation.length - 1];
      const urgency = getResponseUrgency(selectedLead);
      
      // Clean function to remove problematic characters
      const cleanString = (str) => {
        if (!str) return '';
        return str
          .replace(/\r\n/g, ' ')  // Replace Windows line breaks
          .replace(/\n/g, ' ')    // Replace Unix line breaks  
          .replace(/\r/g, ' ')    // Replace Mac line breaks
          .replace(/\t/g, ' ')    // Replace tabs
          .replace(/[\x00-\x1F\x7F-\x9F]/g, '')  // Remove other control characters
          .replace(/"/g, "'")     // Replace double quotes with single quotes
          .replace(/\s+/g, ' ')   // Replace multiple spaces with single space
          .trim();
      };

      // Debug: Log the full payload we're sending
      const payload = {
        id: selectedLead.id,
        email: cleanString(selectedLead.email),
        first_name: cleanString(selectedLead.first_name),
        last_name: cleanString(selectedLead.last_name),
        subject: cleanString(selectedLead.subject),
        intent: selectedLead.intent,
        engagement_score: selectedLead.engagement_score,
        urgency: urgency,
        last_message_type: lastMessage?.type || 'SENT',
        last_message_content: cleanString((lastMessage?.content || '').substring(0, 300)),
        reply_count: selectedLead.conversation.filter(msg => msg.type === 'REPLY').length,
        days_since_last_message: Math.floor((new Date() - new Date(lastMessage?.time || new Date())) / (1000 * 60 * 60 * 24)),
        website: cleanString(selectedLead.website || ''),
        content_brief: cleanString(selectedLead.content_brief || ''),
        conversation: selectedLead.conversation.map(msg => ({
          ...msg,
          content: cleanString(msg.content),
          from: cleanString(msg.from || ''),
          to: cleanString(msg.to || '')
        }))
      };

      // Debug: Log the full payload we're sending
      const fullPayload = {
        id: selectedLead.id,
        email: cleanString(selectedLead.email),
        first_name: cleanString(selectedLead.first_name),
        last_name: cleanString(selectedLead.last_name),
        subject: cleanString(selectedLead.subject),
        intent: selectedLead.intent,
        engagement_score: selectedLead.engagement_score,
        urgency: urgency,
        last_message_type: lastMessage?.type || 'SENT',
        last_message_content: cleanString((lastMessage?.content || '').substring(0, 300)),
        reply_count: selectedLead.conversation.filter(msg => msg.type === 'REPLY').length,
        days_since_last_message: Math.floor((new Date() - new Date(lastMessage?.time || new Date())) / (1000 * 60 * 60 * 24)),
        website: cleanString(selectedLead.website || ''),
        content_brief: cleanString(selectedLead.content_brief || ''),
        conversation: selectedLead.conversation.map(msg => ({
          ...msg,
          content: cleanString(msg.content),
          from: cleanString(msg.from || ''),
          to: cleanString(msg.to || '')
        })),
        email_message_body: selectedLead.email_message_body || ''
      };

      console.log('=== WEBHOOK DEBUG INFO ===');
      console.log('Payload being sent:', JSON.stringify(fullPayload, null, 2));
      console.log('Payload size (characters):', JSON.stringify(fullPayload).length);
      console.log('URL:', 'https://reidsickels.app.n8n.cloud/webhook/8021dcee-ebfd-4cd0-a424-49d7eeb5b66b');
      console.log('Request method: POST');
      console.log('Content-Type: application/json');

      const response = await fetch('https://reidsickels.app.n8n.cloud/webhook/draftmessage', {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(fullPayload)
      });
      
      console.log('=== RESPONSE DEBUG INFO ===');
      console.log('Response status:', response.status);
      console.log('Response headers:', Object.fromEntries(response.headers.entries()));
      
      // Get raw response text to see what we're actually getting
      const responseText = await response.text();
      console.log('Raw response text:', responseText);
      console.log('Response text length:', responseText.length);
      console.log('Response text type:', typeof responseText);
      
      if (!response.ok) {
        console.error('=== ERROR DETAILS ===');
        console.error('Status:', response.status);
        console.error('Status Text:', response.statusText);
        console.error('Response Body:', responseText);
        throw new Error(`HTTP error! status: ${response.status}, body: ${responseText}`);
      }
      
      // Check if response is empty
      if (!responseText || responseText.trim() === '') {
        console.error('Empty response from webhook');
        throw new Error('Empty response from webhook');
      }
      
      // Try to parse JSON response
      let data;
      try {
        data = JSON.parse(responseText);
        console.log('Parsed response data:', data);
      } catch (e) {
        console.error('JSON parsing failed. Raw response:', responseText);
        console.error('JSON parse error:', e.message);
        throw new Error(`Invalid JSON response from webhook. Raw response: ${responseText}`);
      }
      
      // Handle both array and object response formats
      if (data.text) {
        // Clean the response text of any problematic characters
        const cleanResponseText = data.text
          .replace(/\\n/g, '\n')  // Convert literal \n to actual line breaks
          .replace(/\\r/g, '\r')  // Convert literal \r to actual line breaks
          .trim();

        // Update both the text state and HTML content
        setDraftResponse(cleanResponseText);
        const formattedHtml = convertToHtml(cleanResponseText);
        setDraftHtml(formattedHtml);

        // Update the contenteditable div
        const editor = document.querySelector('[contenteditable]');
        if (editor) {
          editor.innerHTML = formattedHtml;
        }

        console.log('Draft set successfully from object format');
      } else if (data && data.length > 0 && data[0].text) {
        const cleanResponseText = data[0].text
          .replace(/\\n/g, '\n')
          .replace(/\\r/g, '\r')
          .trim();

        // Update both the text state and HTML content
        setDraftResponse(cleanResponseText);
        const formattedHtml = convertToHtml(cleanResponseText);
        setDraftHtml(formattedHtml);

        // Update the contenteditable div
        const editor = document.querySelector('[contenteditable]');
        if (editor) {
          editor.innerHTML = formattedHtml;
        }

        console.log('Draft set successfully from array format');
      } else {
        console.error('No text found in response:', data);
        throw new Error('No text content in webhook response');
      }
    } catch (error) {
      console.error('=== FULL ERROR DETAILS ===');
      console.error('Error message:', error.message);
      console.error('Error stack:', error.stack);
      console.error('Selected lead data:', selectedLead);
      
      // Simple fallback for debugging
      setDraftResponse(`Hi ${selectedLead.first_name},\n\nThank you for your message.\n\nBest regards`);
    } finally {
      setIsGeneratingDraft(false);
    }
  };

  // Handle send message
  const sendMessage = async () => {
    const textContent = document.querySelector('[contenteditable]')?.textContent || draftResponse;
    const rawHtmlContent = document.querySelector('[contenteditable]')?.innerHTML || convertToHtml(draftResponse);
    const htmlContent = sanitizeHtml(rawHtmlContent);
    
    if (!textContent.trim()) return;
    
    setIsSending(true);
    try {
      // Parse CC emails from the editable field
      const ccEmails = editableCcEmails
        .split(',')
        .map(email => email.trim())
        .filter(email => email.length > 0)
        .map(email => ({ name: '', address: email }));

      // Get file attachments
      const attachmentInput = document.getElementById('attachment-input');
      const attachments = [];
      if (attachmentInput && attachmentInput.files.length > 0) {
        for (let file of attachmentInput.files) {
          // Convert file to base64 for sending
          const base64 = await new Promise((resolve) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result.split(',')[1]);
            reader.readAsDataURL(file);
          });
          
          attachments.push({
            filename: file.name,
            content: base64,
            encoding: 'base64',
            contentType: file.type
          });
        }
      }
      
      // Prepare payload with editable recipients and HTML content
      const sendPayload = {
        // Draft message data with user-editable recipients and rich formatting
        message: {
          content: textContent.trim(), // Plain text version
          html_content: htmlContent, // Rich HTML version
          to: editableToEmail.trim(),
          cc: ccEmails,
          subject: `Re: ${selectedLead.subject}`,
          type: 'SENT',
          attachments: attachments
        },
        
        // Lead data
        lead: {
          id: selectedLead.id,
          campaign_id: selectedLead.campaign_id,
          lead_id: selectedLead.lead_id,
          email_stats_id: selectedLead.email_stats_id,
          email: editableToEmail.trim(), // Use the editable primary email
          first_name: selectedLead.first_name,
          last_name: selectedLead.last_name,
          subject: selectedLead.subject,
          intent: selectedLead.intent,
          engagement_score: selectedLead.engagement_score,
          urgency: getResponseUrgency(selectedLead),
          website: selectedLead.website || '',
          tags: selectedLead.tags,
          conversation_history: selectedLead.conversation,
          reply_count: selectedLead.conversation.filter(msg => msg.type === 'REPLY').length,
          last_activity: selectedLead.conversation.length > 0 ? selectedLead.conversation[selectedLead.conversation.length - 1].time : selectedLead.created_at,
          // Add recipient info
          cc_recipients: ccEmails.map(cc => cc.address)
        },
        smartlead_api_key: apiKeys.smartlead,
        claude_api_key: apiKeys.claude,
        fullenrich_api_key: apiKeys.fullenrich
      };

      console.log('Sending message with rich formatting:', {
        to: editableToEmail.trim(),
        cc: ccEmails,
        htmlContent: htmlContent,
        attachments: attachments.length,
        payload: sendPayload
      });

      const response = await fetch('https://reidsickels.app.n8n.cloud/webhook/8021dcee-ebfd-4cd0-a424-49d7eeb5b66b', {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(sendPayload)
      });

      console.log('Send response status:', response.status);

      if (!response.ok) {
        const errorText = await response.text();
        console.error('Send webhook error:', errorText);
        throw new Error(`Failed to send message: ${response.status}`);
      }

      const responseData = await response.json();
      console.log('Send response data:', responseData);

      // Show success modal instead of alert
      setShowSentConfirm(true);
      
      // Clear draft and editor
      setDraftResponse('');
      setDraftHtml('');
      const editor = document.querySelector('[contenteditable]');
      if (editor) {
        editor.innerHTML = '';
      }
      
      // Clear file input
      if (attachmentInput) {
        attachmentInput.value = '';
      }
      
      // Optionally refresh leads to get updated data
      await fetchLeads();
      
    } catch (error) {
      console.error('Error sending message:', error);
      alert(`Error sending message: ${error.message}`);
    } finally {
      setIsSending(false);
    }
  };

  // Add enrichment function
  const enrichLeadData = async (lead) => {
    setEnrichingLeads(prev => new Set([...prev, lead.id]));
    try {
      const response = await fetch('https://reidsickels.app.n8n.cloud/webhook/9894a38a-ac26-46b8-89a2-ef2e80e83504', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          ...lead,
          smartlead_api_key: apiKeys.smartlead,
          claude_api_key: apiKeys.claude,
          fullenrich_api_key: apiKeys.fullenrich
        })
      });

      if (!response.ok) {
        throw new Error('Failed to enrich lead data');
      }

      const enrichedData = await response.json();
      console.log('Raw webhook response:', enrichedData);

      // Create a new lead object with the enriched data
      const updatedLead = {
        ...lead,
        role: enrichedData.Role || null,
        company_data: enrichedData["Company Summary"] || null,
        personal_linkedin_url: enrichedData["Personal LinkedIn"] || null,
        business_linkedin_url: enrichedData["Business LinkedIn"] || null,
        last_name: enrichedData["Last Name"] || lead.last_name || ''
      };

      // Update the leads array
      setLeads(prevLeads => prevLeads.map(l => 
        l.id === lead.id ? updatedLead : l
      ));

      // If this is the selected lead, update it with a new object reference
      if (selectedLead?.id === lead.id) {
        setSelectedLead(updatedLead);
      }

      // Show success/not found toast with lead name
      const leadName = `${lead.first_name} ${lead.last_name}`.trim();
      if (enrichedData.Role || enrichedData["Company Summary"] || enrichedData["Personal LinkedIn"] || enrichedData["Business LinkedIn"]) {
        showToast(`Data enriched for ${leadName}`, 'success', lead.id);
      } else {
        showToast(`No additional data found for ${leadName}`, 'error', lead.id);
      }

    } catch (error) {
      console.error('Error enriching lead:', error);
      console.error('Error details:', {
        message: error.message,
        stack: error.stack
      });
      const leadName = `${lead.first_name} ${lead.last_name}`.trim();
      showToast(`Error enriching data for ${leadName}`, 'error', lead.id);
    } finally {
      setEnrichingLeads(prev => {
        const next = new Set(prev);
        next.delete(lead.id);
        return next;
      });
    }
  };

  // Loading state
  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center" style={{backgroundColor: '#1A1C1A'}}>
        <div className="text-center p-8 rounded-2xl shadow-xl" style={{backgroundColor: 'rgba(26, 28, 26, 0.8)', border: '1px solid white'}}>
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 mx-auto mb-4" style={{borderColor: '#54FCFF'}}></div>
          <p className="text-white">Loading leads...</p>
        </div>
      </div>
    );
  }

  // Error state
  if (error) {
    return (
      <div className="flex h-screen items-center justify-center" style={{backgroundColor: '#1A1C1A'}}>
        <div className="text-center">
          <p className="text-red-400 mb-6 font-medium">Error loading leads: {error}</p>
          <button 
            onClick={fetchLeads}
            className="px-4 py-2 text-white rounded-lg hover:opacity-80 transition-colors"
            style={{backgroundColor: '#54FCFF', color: '#1A1C1A', border: '1px solid white'}}
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  // Function to handle API key updates
  const handleApiKeyChange = (key, value) => {
    setApiKeys(prev => {
      if (key === 'esp') {
        // For ESP, we need to handle both provider and key
        return {
          ...prev,
          esp: value
        };
      }
      // For other keys, direct update
      return {
        ...prev,
        [key]: value
      };
    });
  };

  // Function to save API keys (with encryption)
  const saveApiKeys = () => {
    setIsSavingApi(true);
    try {
      // Save ESP settings
      if (apiKeys.esp.provider) {
        localStorage.setItem('esp_provider', apiKeys.esp.provider);
        const encryptedEspKey = encryptApiKey(apiKeys.esp.key);
        localStorage.setItem('esp_api_key_enc', encryptedEspKey);
      }

      // Save Full Enrich key
      const encryptedFullEnrich = encryptApiKey(apiKeys.fullenrich);
      localStorage.setItem('fullenrich_api_key_enc', encryptedFullEnrich);

      // Remove old keys if they exist
      ['smartlead', 'claude'].forEach(oldKey => {
        localStorage.removeItem(`${oldKey}_api_key`);
        localStorage.removeItem(`${oldKey}_api_key_enc`);
      });

      // Show success toast
      setApiToastMessage({
        type: 'success',
        message: 'API keys saved securely'
      });
      setShowApiToast(true);
      setTimeout(() => setShowApiToast(false), 3000);
    } catch (error) {
      console.error('Failed to save API keys:', error);
      setApiToastMessage({
        type: 'error',
        message: 'Failed to save API keys'
      });
      setShowApiToast(true);
      setTimeout(() => setShowApiToast(false), 3000);
    } finally {
      setIsSavingApi(false);
    }
  };

  // Function to toggle all sections
  const toggleAllSections = () => {
    if (activeSection.length === 0) {
      setActiveSection(['general', 'enrichment', 'engagement']);
    } else {
      setActiveSection([]);
    }
  };

  // Function to toggle individual section
  const toggleSection = (section) => {
    setActiveSection(prev => 
      prev.includes(section) 
        ? prev.filter(s => s !== section)
        : [...prev, section]
    );
  };

  const findPhoneNumber = async (lead) => {
    setSearchingPhoneLeads(prev => new Set([...prev, lead.id]));
    try {
      const response = await fetch('https://reidsickels.app.n8n.cloud/webhook/0b5749de-2324-45da-aa36-20971addef0b', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          ...lead,
          smartlead_api_key: apiKeys.smartlead,
          claude_api_key: apiKeys.claude,
          fullenrich_api_key: apiKeys.fullenrich
        })
      });

      if (!response.ok) {
        throw new Error('Failed to find phone number');
      }

      const data = await response.json();
      console.log('Raw webhook response:', data);

      // Extract phone number from the nested structure
      const phoneNumber = data?.datas?.[0]?.contact?.phones?.[0]?.number || null;

      // Create a new lead object with the phone number
      const updatedLead = {
        ...lead,
        phone: phoneNumber
      };

      // Update the leads array
      setLeads(prevLeads => prevLeads.map(l => 
        l.id === lead.id ? updatedLead : l
      ));

      // If this is the selected lead, update it with a new object reference
      if (selectedLead?.id === lead.id) {
        setSelectedLead(updatedLead);
      }

      // Show success/not found toast with lead name
      const leadName = `${lead.first_name} ${lead.last_name}`.trim();
      if (phoneNumber) {
        showToast(`Phone found for ${leadName}`, 'success', lead.id);
      } else {
        showToast(`No phone found for ${leadName}`, 'error', lead.id);
      }

    } catch (error) {
      console.error('Error finding phone number:', error);
      console.error('Error details:', {
        message: error.message,
        stack: error.stack
      });
      const leadName = `${lead.first_name} ${lead.last_name}`.trim();
      showToast(`Error searching phone for ${leadName}`, 'error', lead.id);
    } finally {
      setSearchingPhoneLeads(prev => {
        const next = new Set(prev);
        next.delete(lead.id);
        return next;
      });
    }
  };

  // Add a helper function to get active filter count
  const getActiveFilterCount = () => {
    return Object.values(activeFilters)
      .reduce((count, values) => count + (Array.isArray(values) ? values.length : 0), 0);
  };

  // Update the urgency filter buttons
  const handleUrgencyFilter = (urgencyType) => {
    // If this urgency is already active, clear it
    if (activeFilters.urgency?.includes(urgencyType)) {
      handleRemoveFilter('urgency', urgencyType);
    } else {
      // Otherwise, set only this urgency
      handleAddFilter('urgency', urgencyType);
    }
  };

  return (
    <div className="flex h-screen relative overflow-hidden transition-colors duration-300" style={{backgroundColor: themeStyles.primaryBg}}>
      {/* Top Navigation Bar */}
      <div className="absolute top-0 left-0 right-0 h-12 bg-opacity-50 backdrop-blur-md z-20 flex items-center px-6 transition-colors duration-300" style={{backgroundColor: themeStyles.secondaryBg, borderBottom: `1px solid ${themeStyles.border}`}}>
        <div className="flex justify-between items-center w-full">
          <div className="flex space-x-4">
            <button
              onClick={() => setActiveTab('all')}
              className={`px-4 py-2 rounded-lg text-sm font-medium transition-all ${
                (activeTab === 'all' || activeTab === 'need_response' || activeTab === 'recently_sent') ? `text-white` : `hover:bg-white/5`
              }`}
              style={{
                backgroundColor: (activeTab === 'all' || activeTab === 'need_response' || activeTab === 'recently_sent') ? `${themeStyles.accent}20` : 'transparent',
                color: (activeTab === 'all' || activeTab === 'need_response' || activeTab === 'recently_sent') ? themeStyles.accent : themeStyles.textPrimary
              }}
            >
              <div className="flex items-center gap-2">
                <Mail className="w-4 h-4" />
                Inbox
              </div>
            </button>

            <button
              onClick={() => setActiveTab('analytics')}
              className={`px-4 py-2 rounded-lg text-sm font-medium transition-all ${
                activeTab === 'analytics' ? `text-white` : `hover:bg-white/5`
              }`}
              style={{
                backgroundColor: activeTab === 'analytics' ? `${themeStyles.accent}20` : 'transparent',
                color: activeTab === 'analytics' ? themeStyles.accent : themeStyles.textPrimary
              }}
            >
              <div className="flex items-center gap-2">
                <BarChart3 className="w-4 h-4" />
                Analytics
              </div>
            </button>

            {/* Recently Viewed Dropdown */}
            {recentlyViewed.length > 0 && (
              <div className="relative recent-dropdown">
                <button
                  onClick={() => setShowRecentDropdown(!showRecentDropdown)}
                  className="px-4 py-2 rounded-lg text-sm font-medium transition-all hover:bg-white/5 flex items-center gap-2"
                  style={{color: themeStyles.textPrimary}}
                >
                  <Clock className="w-4 h-4" />
                  Recent ({recentlyViewed.length})
                  <ChevronDown className="w-3 h-3" />
                </button>

                {showRecentDropdown && (
                  <div className="absolute top-full left-0 mt-2 w-64 rounded-lg shadow-lg z-50 max-h-80 overflow-y-auto transition-colors duration-300" style={{backgroundColor: themeStyles.secondaryBg, border: `1px solid ${themeStyles.border}`}}>
                    <div className="p-3">
                      <h4 className="font-medium mb-2 transition-colors duration-300" style={{color: themeStyles.textPrimary}}>Recently Viewed</h4>
                      <div className="space-y-1">
                        {recentlyViewed.map((recent) => (
                          <button
                            key={recent.id}
                            onClick={() => {
                              const lead = leads.find(l => l.id === recent.id);
                              if (lead) {
                                setSelectedLead(lead);
                                setShowRecentDropdown(false);
                              }
                            }}
                            className="w-full text-left px-3 py-2 rounded-lg text-sm transition-all duration-300 hover:opacity-80"
                            style={{
                              backgroundColor: selectedLead?.id === recent.id ? `${themeStyles.accent}20` : themeStyles.tertiaryBg,
                              color: themeStyles.textPrimary
                            }}
                          >
                            <div className="font-medium">{recent.name}</div>
                            <div className="text-xs transition-colors duration-300" style={{color: themeStyles.textMuted}}>{recent.email}</div>
                          </button>
                        ))}
                      </div>
                      <button
                        onClick={() => {
                          setRecentlyViewed([]);
                          localStorage.removeItem('inbox_manager_recent_leads');
                          setShowRecentDropdown(false);
                        }}
                        className="w-full mt-3 px-3 py-2 text-xs rounded-lg transition-all duration-300 hover:opacity-80"
                        style={{backgroundColor: themeStyles.tertiaryBg, color: themeStyles.textMuted}}
                      >
                        Clear Recent
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}

            <button
              onClick={() => setShowApiSettings(true)}
              className={`px-4 py-2 rounded-lg text-sm font-medium transition-all ${
                showApiSettings ? 'text-white' : 'hover:bg-white/5'
              }`}
              style={{
                backgroundColor: showApiSettings ? `${themeStyles.accent}20` : 'transparent',
                color: showApiSettings ? themeStyles.accent : themeStyles.textPrimary
              }}
            >
              <div className="flex items-center gap-2">
                <Key className="w-4 h-4" />
                API Settings
              </div>
            </button>
          </div>

          {/* User Actions */}
          <div className="flex items-center gap-3">
            {/* User Info */}
            <div className="text-sm">
              <span className="text-white/80">Welcome, </span>
              <span className="text-white font-medium">{user?.email}</span>
            </div>

            {/* Theme Toggle */}
            <button
              onClick={toggleTheme}
              className="px-3 py-2 rounded-lg text-sm font-medium transition-all hover:bg-white/5 flex items-center gap-2"
              style={{color: themeStyles.textPrimary}}
              title={`Switch to ${isDarkMode ? 'light' : 'dark'} mode`}
            >
              {isDarkMode ? (
                <>
                  <span className="text-lg">☀️</span>
                  <span className="hidden sm:inline">Light</span>
                </>
              ) : (
                <>
                  <span className="text-lg">🌙</span>
                  <span className="hidden sm:inline">Dark</span>
                </>
              )}
            </button>

            {/* Logout Button */}
            <button
              onClick={signOut}
              className="px-3 py-2 rounded-lg text-sm font-medium transition-all hover:bg-white/5 flex items-center gap-2 text-red-400 hover:text-red-300"
              title="Sign out"
            >
              <LogOut className="w-4 h-4" />
              <span className="hidden sm:inline">Sign Out</span>
            </button>
          </div>
        </div>
      </div>

      {/* API Settings Modal */}
      {showApiSettings && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
          <div className="bg-[#1A1C1A] rounded-xl shadow-xl max-w-2xl w-full border border-white/10 overflow-hidden">
            <div className="p-6 border-b border-white/10">
              <div className="flex justify-between items-center">
                <h2 className="text-xl font-semibold text-white flex items-center gap-2">
                  <Key className="w-5 h-5" style={{color: '#54FCFF'}} />
                  API Settings
                </h2>
                <button
                  onClick={() => setShowApiSettings(false)}
                  className="text-gray-400 hover:text-white transition-colors"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>
            </div>
            
            <div className="p-6 space-y-6">
              {/* Security Notice */}
              <div className="bg-[#1A1C1A] border border-[#00FF8C]/20 rounded-lg p-3">
                <div className="flex items-center gap-2 text-[#00FF8C] text-sm">
                  <CheckCircle className="w-4 h-4" />
                  <span className="font-medium">Secure Storage Enabled</span>
                </div>
                <p className="text-xs text-[#00FF8C]/80 mt-1">API keys are encrypted before storage for enhanced security</p>
              </div>

              {/* Email Service Provider Section */}
              <div className="space-y-4">
                <div className="flex items-center gap-2">
                  <Mail className="w-4 h-4" style={{color: '#54FCFF'}} />
                  <h3 className="font-medium text-[#54FCFF]">Email Service Provider</h3>
                </div>

                {/* ESP Selection */}
                <div className="grid grid-cols-3 gap-3">
                  {['Email Bison', 'Smartlead', 'Instantly'].map(provider => (
                    <button
                      key={provider}
                      onClick={() => handleApiKeyChange('esp', { ...apiKeys.esp, provider: provider.toLowerCase() })}
                      className={`px-4 py-2 rounded-lg text-sm font-medium transition-all text-white ${
                        apiKeys.esp.provider === provider.toLowerCase() 
                          ? 'bg-[#54FCFF]/10 border-[#54FCFF] text-[#54FCFF]' 
                          : 'bg-[#1A1C1A] border-white/10 hover:bg-[#1A1C1A]/80'
                      }`}
                      style={{border: '1px solid'}}
                    >
                      {provider}
                    </button>
                  ))}
                </div>

                {/* ESP API Key Input */}
                {apiKeys.esp.provider && (
                  <div className="space-y-2">
                    <label className="text-sm text-white/60">
                      {apiKeys.esp.provider.charAt(0).toUpperCase() + apiKeys.esp.provider.slice(1)} API Key
                    </label>
                    <div className="relative">
                                          <input
                      type="password"
                      value={apiKeys.esp.key}
                      onChange={(e) => handleApiKeyChange('esp', { ...apiKeys.esp, key: e.target.value })}
                      className="w-full px-4 py-2 rounded-lg text-white placeholder-gray-400 bg-[#1A1C1A] border border-white/10 focus:border-[#54FCFF] focus:ring-1 focus:ring-[#54FCFF] transition-all"
                      placeholder={`Enter ${apiKeys.esp.provider} API key`}
                    />
                      {apiTestStatus.esp === true && (
                        <CheckCircle className="absolute right-3 top-1/2 transform -translate-y-1/2 w-5 h-5 text-green-400" />
                      )}
                    </div>
                  </div>
                )}
              </div>

              {/* Data Enrichment Section */}
              <div className="space-y-4 pt-6 mt-6 border-t border-white/10">
                <div className="flex items-center gap-2">
                  <Database className="w-4 h-4" style={{color: '#54FCFF'}} />
                  <h3 className="font-medium text-[#54FCFF]">Data Enrichment</h3>
                </div>

                <div className="space-y-2">
                  <label className="text-sm text-white/60">
                    Full Enrich API Key
                  </label>
                  <div className="relative">
                    <input
                      type="password"
                      value={apiKeys.fullenrich}
                      onChange={(e) => handleApiKeyChange('fullenrich', e.target.value)}
                      className="w-full px-4 py-2 rounded-lg text-white placeholder-gray-400 bg-[#1A1C1A] border border-white/10 focus:border-[#54FCFF] focus:ring-1 focus:ring-[#54FCFF] transition-all"
                      placeholder="Enter Full Enrich API key"
                    />
                    {apiTestStatus.fullenrich === true && (
                      <CheckCircle className="absolute right-3 top-1/2 transform -translate-y-1/2 w-5 h-5 text-green-400" />
                    )}
                  </div>
                  <p className="text-xs text-white/40 mt-2">
                    Used for finding phone numbers, company data, and social profiles
                  </p>
                </div>
              </div>
            </div>

            <div className="p-6 bg-[#1A1C1A] border-t border-white/10 flex justify-end gap-3">
              <button
                onClick={() => setShowApiSettings(false)}
                className="px-4 py-2 rounded-lg text-white hover:bg-white/5 transition-colors text-sm"
              >
                Cancel
              </button>
              <button
                onClick={saveApiKeys}
                disabled={isSavingApi}
                className="px-4 py-2 rounded-lg bg-[#54FCFF] text-black font-medium hover:opacity-90 transition-all text-sm flex items-center gap-2 disabled:opacity-50"
              >
                {isSavingApi ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Saving...
                  </>
                ) : (
                  <>
                    <Save className="w-4 h-4" />
                    Save API Keys
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Success/Error Toast */}
      {showApiToast && (
        <div className="fixed top-4 right-4 z-50 animate-slideIn">
          <div className={`rounded-lg shadow-lg p-4 text-sm font-medium flex items-center gap-2 ${
            apiToastMessage.type === 'success' 
              ? 'bg-green-400 text-green-900' 
              : 'bg-red-400 text-red-900'
          }`}>
            {apiToastMessage.type === 'success' ? (
              <CheckCircle className="w-4 h-4" />
            ) : (
              <AlertCircle className="w-4 h-4" />
            )}
            {apiToastMessage.message}
          </div>
        </div>
      )}

      {/* Toast Notifications Container */}
      <div className="fixed top-4 right-4 z-50 flex flex-col-reverse gap-2">
        {toasts.map(toast => (
          <div 
            key={toast.id}
            className="flex items-center gap-2 px-4 py-3 rounded-lg shadow-lg cursor-pointer transition-all transform hover:scale-102 min-w-[200px]"
            style={{
              backgroundColor: toast.type === 'success' 
                ? `${themeStyles.success}20` 
                : `${themeStyles.error}20`,
              border: `1px solid ${toast.type === 'success' ? themeStyles.success : themeStyles.error}`,
              backdropFilter: 'blur(8px)',
              animation: 'slideIn 0.2s ease-out'
            }}
            onClick={() => {
              if (toast.leadId) {
                const lead = leads.find(l => l.id === toast.leadId);
                if (lead) {
                  setSelectedLead(lead);
                  removeToast(toast.id);
                }
              }
            }}
          >
            {toast.type === 'success' ? (
              <CheckCircle className="w-5 h-5 shrink-0" style={{color: themeStyles.success}} />
            ) : (
              <AlertCircle className="w-5 h-5 shrink-0" style={{color: themeStyles.error}} />
            )}
            <span className="text-sm font-medium flex-1 transition-colors duration-300" style={{color: themeStyles.textPrimary}}>{toast.message}</span>
            <button 
              onClick={(e) => {
                e.stopPropagation();
                removeToast(toast.id);
              }}
              className="ml-2 shrink-0 hover:opacity-80 transition-colors duration-300"
              style={{color: themeStyles.textMuted}}
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        ))}
      </div>

      <style jsx global>{`
        @keyframes slideIn {
          from {
            transform: translateX(100%);
            opacity: 0;
          }
          to {
            transform: translateX(0);
            opacity: 1;
          }
        }
        
        @keyframes glow {
          0% { opacity: 0.5; }
          100% { opacity: 1; }
        }
        
        /* Theme transition animations */
        * {
          transition: background-color 0.3s ease, color 0.3s ease, border-color 0.3s ease;
        }
        
        /* Custom scrollbar for theme */
        ::-webkit-scrollbar {
          width: 8px;
        }
        
        ::-webkit-scrollbar-track {
          background: ${isDarkMode ? 'rgba(255, 255, 255, 0.1)' : 'rgba(0, 0, 0, 0.1)'};
          border-radius: 4px;
        }
        
        ::-webkit-scrollbar-thumb {
          background: ${themeStyles.accent};
          border-radius: 4px;
        }
        
        ::-webkit-scrollbar-thumb:hover {
          background: ${themeStyles.accent}CC;
        }
      `}</style>

      {/* Add margin-top to main content to account for nav bar */}
      <div className="flex-1 flex mt-12">
        {/* Analytics Dashboard */}
        {activeTab === 'analytics' && (
          <div className="flex-1 p-8 overflow-y-auto transition-colors duration-300" style={{backgroundColor: themeStyles.primaryBg}}>
            <div className="max-w-7xl mx-auto space-y-8">
              {/* Analytics Header */}
              <div className="flex justify-between items-center">
                <div>
                  <h1 className="text-3xl font-bold transition-colors duration-300" style={{color: themeStyles.textPrimary}}>
                    Analytics Dashboard
                  </h1>
                  <p className="mt-2 transition-colors duration-300" style={{color: themeStyles.textSecondary}}>
                    Insights and performance metrics for your lead management
                  </p>
                </div>
                
                {/* Date Range Selector */}
                <div className="flex items-center gap-2">
                  <span className="text-sm transition-colors duration-300" style={{color: themeStyles.textSecondary}}>Show data for:</span>
                  <select
                    value={analyticsDateRange}
                    onChange={(e) => setAnalyticsDateRange(e.target.value)}
                    className="px-3 py-2 rounded-lg text-sm transition-colors duration-300"
                    style={{
                      backgroundColor: themeStyles.secondaryBg,
                      border: `1px solid ${themeStyles.border}`,
                      color: themeStyles.textPrimary
                    }}
                  >
                    <option value="7">Last 7 days</option>
                    <option value="30">Last 30 days</option>
                    <option value="90">Last 90 days</option>
                    <option value="365">Last year</option>
                  </select>
                </div>
              </div>

              {analyticsData ? (
                <>
                  {/* KPI Cards */}
                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
                    <div className="p-6 rounded-2xl shadow-lg transition-colors duration-300" style={{backgroundColor: themeStyles.secondaryBg, border: `1px solid ${themeStyles.border}`}}>
                      <div className="flex items-center justify-between">
                        <div>
                          <p className="text-sm transition-colors duration-300" style={{color: themeStyles.textMuted}}>Total Leads</p>
                          <p className="text-2xl font-bold transition-colors duration-300" style={{color: themeStyles.textPrimary}}>
                            {analyticsData.totalLeads.toLocaleString()}
                          </p>
                        </div>
                        <Users className="w-8 h-8 transition-colors duration-300" style={{color: themeStyles.accent}} />
                      </div>
                    </div>

                    <div className="p-6 rounded-2xl shadow-lg transition-colors duration-300" style={{backgroundColor: themeStyles.secondaryBg, border: `1px solid ${themeStyles.border}`}}>
                      <div className="flex items-center justify-between">
                        <div>
                          <p className="text-sm transition-colors duration-300" style={{color: themeStyles.textMuted}}>Engagement Rate</p>
                          <p className="text-2xl font-bold transition-colors duration-300" style={{color: themeStyles.success}}>
                            {analyticsData.engagementRate.toFixed(1)}%
                          </p>
                          <p className="text-xs transition-colors duration-300" style={{color: themeStyles.textMuted}}>
                            Leads with 2+ replies
                          </p>
                        </div>
                        <TrendingUp className="w-8 h-8 transition-colors duration-300" style={{color: themeStyles.success}} />
                      </div>
                    </div>

                    <div className="p-6 rounded-2xl shadow-lg transition-colors duration-300" style={{backgroundColor: themeStyles.secondaryBg, border: `1px solid ${themeStyles.border}`}}>
                      <div className="flex items-center justify-between">
                        <div>
                          <p className="text-sm transition-colors duration-300" style={{color: themeStyles.textMuted}}>Avg Response Time</p>
                          <p className="text-2xl font-bold transition-colors duration-300" style={{color: themeStyles.accent}}>
                            {formatResponseTime(analyticsData.avgResponseTime)}
                          </p>
                        </div>
                        <Clock className="w-8 h-8 transition-colors duration-300" style={{color: themeStyles.accent}} />
                      </div>
                    </div>

                    <div className="p-6 rounded-2xl shadow-lg transition-colors duration-300" style={{backgroundColor: themeStyles.secondaryBg, border: `1px solid ${themeStyles.border}`}}>
                      <div className="flex items-center justify-between">
                        <div>
                          <p className="text-sm transition-colors duration-300" style={{color: themeStyles.textMuted}}>Avg Replies per Lead</p>
                          <p className="text-2xl font-bold transition-colors duration-300" style={{color: themeStyles.textPrimary}}>
                            {analyticsData.avgRepliesPerLead.toFixed(1)}
                          </p>
                          <p className="text-xs transition-colors duration-300" style={{color: themeStyles.textMuted}}>
                            {analyticsData.totalReplies} total replies
                          </p>
                        </div>
                        <MessageSquare className="w-8 h-8 transition-colors duration-300" style={{color: themeStyles.accent}} />
                      </div>
                    </div>
                  </div>

                  {/* Charts Grid */}
                  <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
                    {/* Response Time Distribution */}
                    <div className="p-6 rounded-2xl shadow-lg transition-colors duration-300" style={{backgroundColor: themeStyles.secondaryBg, border: `1px solid ${themeStyles.border}`}}>
                      <h3 className="text-xl font-bold mb-4 transition-colors duration-300" style={{color: themeStyles.textPrimary}}>
                        Response Time Distribution
                      </h3>
                      <div className="space-y-3">
                        {Object.entries(analyticsData.responseTimeDistribution).map(([timeRange, count]) => {
                          const total = Object.values(analyticsData.responseTimeDistribution).reduce((sum, val) => sum + val, 0);
                          const percentage = total > 0 ? (count / total * 100) : 0;
                          const label = {
                            'under1h': 'Under 1 hour',
                            '1to4h': '1-4 hours',
                            '4to24h': '4-24 hours',
                            'over24h': 'Over 24 hours'
                          }[timeRange];
                          
                          return (
                            <div key={timeRange} className="flex items-center justify-between">
                              <span className="text-sm transition-colors duration-300" style={{color: themeStyles.textSecondary}}>{label}</span>
                              <div className="flex items-center gap-3">
                                <div className="w-32 rounded-full h-2 transition-colors duration-300" style={{backgroundColor: themeStyles.tertiaryBg}}>
                                  <div 
                                    className="h-2 rounded-full transition-all duration-500"
                                    style={{
                                      width: `${percentage}%`,
                                      backgroundColor: themeStyles.accent
                                    }}
                                  />
                                </div>
                                <span className="text-sm font-medium w-12 text-right transition-colors duration-300" style={{color: themeStyles.textPrimary}}>
                                  {count}
                                </span>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>

                    {/* Average Replies by Intent Level */}
                    <div className="p-6 rounded-2xl shadow-lg transition-colors duration-300" style={{backgroundColor: themeStyles.secondaryBg, border: `1px solid ${themeStyles.border}`}}>
                      <h3 className="text-xl font-bold mb-4 transition-colors duration-300" style={{color: themeStyles.textPrimary}}>
                        Average Replies by Intent Level
                      </h3>
                      <div className="space-y-4">
                        {analyticsData.intentCorrelation.map((item, index) => (
                          <div key={index} className="flex items-center justify-between">
                            <div className="flex items-center gap-2">
                              <span className="text-sm transition-colors duration-300" style={{color: themeStyles.textSecondary}}>{item.intent}</span>
                              <span className="text-xs px-2 py-1 rounded-full transition-colors duration-300" style={{backgroundColor: themeStyles.tertiaryBg, color: themeStyles.textMuted}}>
                                {item.count} leads
                              </span>
                            </div>
                            <div className="flex items-center gap-3">
                              <div className="w-32 rounded-full h-3 transition-colors duration-300" style={{backgroundColor: themeStyles.tertiaryBg}}>
                                <div 
                                  className="h-3 rounded-full transition-all duration-500"
                                  style={{
                                    width: `${Math.min(item.avgReplies * 20, 100)}%`, // Scale for visual
                                    backgroundColor: index === 0 ? themeStyles.success : index === 1 ? themeStyles.warning : themeStyles.accent
                                  }}
                                />
                              </div>
                              <span className="text-sm font-bold w-12 text-right transition-colors duration-300" style={{color: themeStyles.textPrimary}}>
                                {item.avgReplies.toFixed(1)}
                              </span>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>

                  {/* Reply Activity Heatmap */}
                  <div className="p-6 rounded-2xl shadow-lg transition-colors duration-300" style={{backgroundColor: themeStyles.secondaryBg, border: `1px solid ${themeStyles.border}`}}>
                    <div className="flex justify-between items-center mb-4">
                      <h3 className="text-xl font-bold transition-colors duration-300" style={{color: themeStyles.textPrimary}}>
                        Reply Activity Heatmap
                      </h3>
                      {analyticsData.peakHour && analyticsData.maxCount > 0 && (
                        <div className="text-sm transition-colors duration-300" style={{color: themeStyles.textSecondary}}>
                          Peak: {analyticsData.peakHour.dayName} at {analyticsData.peakHour.hour}:00 ({analyticsData.maxCount} replies)
                        </div>
                      )}
                    </div>
                    
                    {/* Heatmap Grid */}
                    <div className="relative">
                      {/* Hour labels */}
                      <div className="flex mb-2 ml-16">
                        {Array.from({ length: 24 }, (_, hour) => (
                          <div key={hour} className="flex-1 text-center text-xs transition-colors duration-300" style={{color: themeStyles.textMuted}}>
                            {hour % 4 === 0 ? `${hour}:00` : ''}
                          </div>
                        ))}
                      </div>
                      
                      {/* Heatmap rows */}
                      {['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'].map((dayName, dayIndex) => (
                        <div key={dayName} className="flex items-center mb-1">
                          <div className="w-14 text-xs text-right mr-2 transition-colors duration-300" style={{color: themeStyles.textMuted}}>
                            {dayName.slice(0, 3)}
                          </div>
                          <div className="flex flex-1 gap-1">
                            {Array.from({ length: 24 }, (_, hour) => {
                              const dataPoint = analyticsData.heatmapData.find(d => 
                                d.day === ((dayIndex + 1) % 7) && d.hour === hour // Adjust for Sunday=0
                              );
                              const intensity = analyticsData.maxCount > 0 ? (dataPoint?.count || 0) / analyticsData.maxCount : 0;
                              
                              return (
                                <div
                                  key={hour}
                                  className="flex-1 h-6 rounded-sm transition-all duration-300 hover:scale-110 cursor-pointer"
                                  style={{
                                    backgroundColor: intensity > 0 
                                      ? `${themeStyles.accent}${Math.floor(intensity * 255).toString(16).padStart(2, '0')}`
                                      : themeStyles.tertiaryBg,
                                    border: `1px solid ${themeStyles.border}`
                                  }}
                                  title={`${dayName} ${hour}:00 - ${dataPoint?.count || 0} replies`}
                                />
                              );
                            })}
                          </div>
                        </div>
                      ))}
                      
                      {/* Legend */}
                      <div className="flex items-center justify-center mt-4 gap-4">
                        <span className="text-xs transition-colors duration-300" style={{color: themeStyles.textMuted}}>Less</span>
                        <div className="flex gap-1">
                          {[0, 0.2, 0.4, 0.6, 0.8, 1].map((intensity, i) => (
                            <div
                              key={i}
                              className="w-3 h-3 rounded-sm"
                              style={{
                                backgroundColor: intensity > 0 
                                  ? `${themeStyles.accent}${Math.floor(intensity * 255).toString(16).padStart(2, '0')}`
                                  : themeStyles.tertiaryBg,
                                border: `1px solid ${themeStyles.border}`
                              }}
                            />
                          ))}
                        </div>
                        <span className="text-xs transition-colors duration-300" style={{color: themeStyles.textMuted}}>More</span>
                      </div>
                    </div>
                  </div>

                  {/* Message Copy Analysis */}
                  <div className="p-6 rounded-2xl shadow-lg transition-colors duration-300" style={{backgroundColor: themeStyles.secondaryBg, border: `1px solid ${themeStyles.border}`}}>
                    <h3 className="text-xl font-bold mb-6 transition-colors duration-300" style={{color: themeStyles.textPrimary}}>
                      What Works in Messages
                    </h3>

                    {/* Message Length Analysis */}
                    <div className="mb-8">
                      <h4 className="text-sm font-medium mb-4 transition-colors duration-300" style={{color: themeStyles.textSecondary}}>Message Length Impact</h4>
                      <div className="grid grid-cols-4 gap-4">
                        {analyticsData.copyInsights.lengthBreakdown.map((length, index) => {
                          const replyRate = length.messages > 0 ? (length.replies / length.messages * 100) : 0;
                          return (
                            <div key={index} className="p-4 rounded-lg transition-colors duration-300" style={{backgroundColor: themeStyles.tertiaryBg}}>
                              <div className="text-sm font-medium mb-2 transition-colors duration-300" style={{color: themeStyles.textPrimary}}>
                                {length.range}
                              </div>
                              <div className="text-2xl font-bold mb-1 transition-colors duration-300" style={{color: themeStyles.accent}}>
                                {replyRate.toFixed(1)}%
                              </div>
                              <div className="text-xs transition-colors duration-300" style={{color: themeStyles.textMuted}}>
                                {length.messages} messages sent
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>

                    {/* Pattern Success Rates */}
                    <div className="mb-8">
                      <h4 className="text-sm font-medium mb-4 transition-colors duration-300" style={{color: themeStyles.textSecondary}}>Message Pattern Success</h4>
                      <div className="space-y-4">
                        {[
                          { label: 'Contains Questions', data: analyticsData.copyInsights.withQuestions },
                          { label: 'Suggests Call/Meeting', data: analyticsData.copyInsights.withCalls },
                          { label: 'Discusses Pricing', data: analyticsData.copyInsights.withPricing },
                          { label: 'Value Proposition', data: analyticsData.copyInsights.withValueProps }
                        ].map((pattern, index) => {
                          const successRate = pattern.data.total > 0 
                            ? (pattern.data.success / pattern.data.total * 100)
                            : 0;
                          return (
                            <div key={index} className="flex items-center gap-4">
                              <div className="flex-1">
                                <div className="flex justify-between mb-2">
                                  <span className="text-sm transition-colors duration-300" style={{color: themeStyles.textPrimary}}>{pattern.label}</span>
                                  <span className="text-sm font-medium transition-colors duration-300" style={{color: themeStyles.accent}}>{successRate.toFixed(1)}% success</span>
                                </div>
                                <div className="h-2 rounded-full transition-colors duration-300" style={{backgroundColor: themeStyles.tertiaryBg}}>
                                  <div 
                                    className="h-2 rounded-full transition-all duration-500"
                                    style={{
                                      width: `${successRate}%`,
                                      backgroundColor: themeStyles.accent
                                    }}
                                  />
                                </div>
                              </div>
                              <div className="text-xs transition-colors duration-300" style={{color: themeStyles.textMuted}}>
                                {pattern.data.success}/{pattern.data.total} replies
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>

                    {/* Response Time Analysis */}
                    <div>
                      <h4 className="text-sm font-medium mb-4 transition-colors duration-300" style={{color: themeStyles.textSecondary}}>Average Response Time by Pattern</h4>
                      <div className="grid grid-cols-4 gap-4">
                        {[
                          { label: 'Questions', time: analyticsData.copyInsights.avgReplyTime.withQuestion },
                          { label: 'Call/Meeting', time: analyticsData.copyInsights.avgReplyTime.withCall },
                          { label: 'Pricing', time: analyticsData.copyInsights.avgReplyTime.withPricing },
                          { label: 'Value Prop', time: analyticsData.copyInsights.avgReplyTime.withValueProp }
                        ].map((timing, index) => (
                          <div key={index} className="p-4 rounded-lg transition-colors duration-300" style={{backgroundColor: themeStyles.tertiaryBg}}>
                            <div className="text-sm mb-2 transition-colors duration-300" style={{color: themeStyles.textPrimary}}>{timing.label}</div>
                            <div className="text-xl font-bold transition-colors duration-300" style={{color: themeStyles.accent}}>
                              {formatResponseTime(timing.time)}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>

                  {/* Campaign Performance Table */}
                  <div className="p-6 rounded-2xl shadow-lg transition-colors duration-300" style={{backgroundColor: themeStyles.secondaryBg, border: `1px solid ${themeStyles.border}`}}>
                    <h3 className="text-xl font-bold mb-4 transition-colors duration-300" style={{color: themeStyles.textPrimary}}>
                      Top Performing Campaigns
                    </h3>
                    <div className="overflow-x-auto">
                      <table className="w-full">
                        <thead>
                          <tr className="border-b transition-colors duration-300" style={{borderColor: themeStyles.border}}>
                            <th className="text-left py-3 px-4 font-medium transition-colors duration-300" style={{color: themeStyles.textSecondary}}>Campaign</th>
                            <th className="text-left py-3 px-4 font-medium transition-colors duration-300" style={{color: themeStyles.textSecondary}}>Leads</th>
                            <th className="text-left py-3 px-4 font-medium transition-colors duration-300" style={{color: themeStyles.textSecondary}}>Avg Engagement</th>
                            <th className="text-left py-3 px-4 font-medium transition-colors duration-300" style={{color: themeStyles.textSecondary}}>Avg Replies</th>
                            <th className="text-left py-3 px-4 font-medium transition-colors duration-300" style={{color: themeStyles.textSecondary}}>Avg Response Time</th>
                          </tr>
                        </thead>
                        <tbody>
                          {analyticsData.campaignStats.slice(0, 5).map((campaign, index) => (
                            <tr key={index} className="border-b transition-colors duration-300" style={{borderColor: themeStyles.border}}>
                              <td className="py-3 px-4 transition-colors duration-300" style={{color: themeStyles.textPrimary}}>{campaign.name}</td>
                              <td className="py-3 px-4 transition-colors duration-300" style={{color: themeStyles.textPrimary}}>{campaign.totalLeads}</td>
                              <td className="py-3 px-4">
                                <span className="px-2 py-1 rounded-full text-xs font-medium transition-colors duration-300" 
                                      style={{
                                        backgroundColor: campaign.avgEngagement >= 80 ? `${themeStyles.success}20` : 
                                                        campaign.avgEngagement >= 50 ? `${themeStyles.warning}20` : `${themeStyles.error}20`,
                                        color: campaign.avgEngagement >= 80 ? themeStyles.success : 
                                               campaign.avgEngagement >= 50 ? themeStyles.warning : themeStyles.error
                                      }}>
                                  {campaign.avgEngagement.toFixed(0)}%
                                </span>
                              </td>
                              <td className="py-3 px-4 transition-colors duration-300" style={{color: themeStyles.textPrimary}}>{campaign.avgRepliesPerLead.toFixed(1)}</td>
                              <td className="py-3 px-4 transition-colors duration-300" style={{color: themeStyles.textPrimary}}>
                                {campaign.avgResponseTime > 0 ? formatResponseTime(campaign.avgResponseTime) : 'N/A'}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>

                  {/* Category Performance */}
                  <div className="p-6 rounded-2xl shadow-lg transition-colors duration-300" style={{backgroundColor: themeStyles.secondaryBg, border: `1px solid ${themeStyles.border}`}}>
                    <h3 className="text-xl font-bold mb-4 transition-colors duration-300" style={{color: themeStyles.textPrimary}}>
                      Performance by Lead Category
                    </h3>
                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                      {analyticsData.categoryStats.map((category, index) => (
                        <div key={index} className="p-4 rounded-lg transition-colors duration-300" style={{backgroundColor: themeStyles.tertiaryBg, border: `1px solid ${themeStyles.border}`}}>
                          <div className="flex justify-between items-center mb-2">
                            <span className="font-medium transition-colors duration-300" style={{color: themeStyles.textPrimary}}>{category.category}</span>
                            <span className="text-sm transition-colors duration-300" style={{color: themeStyles.textMuted}}>{category.totalLeads} leads</span>
                          </div>
                          
                          {/* Engagement Score */}
                          <div className="flex items-center gap-2 mb-2">
                            <span className="text-xs transition-colors duration-300" style={{color: themeStyles.textMuted}}>Engagement:</span>
                            <div className="flex-1 rounded-full h-2 transition-colors duration-300" style={{backgroundColor: themeStyles.tertiaryBg}}>
                              <div 
                                className="h-2 rounded-full transition-all duration-500"
                                style={{
                                  width: `${category.avgEngagement}%`,
                                  backgroundColor: themeStyles.success
                                }}
                              />
                            </div>
                            <span className="text-xs font-bold w-10 text-right transition-colors duration-300" style={{color: themeStyles.textPrimary}}>
                              {category.avgEngagement.toFixed(0)}%
                            </span>
                          </div>
                          
                          {/* Average Replies */}
                          <div className="flex items-center justify-between text-xs">
                            <span className="transition-colors duration-300" style={{color: themeStyles.textMuted}}>
                              Avg replies: <span className="font-medium transition-colors duration-300" style={{color: themeStyles.textPrimary}}>{category.avgRepliesPerLead.toFixed(1)}</span>
                            </span>
                            <span className="transition-colors duration-300" style={{color: themeStyles.textMuted}}>
                              Avg response: <span className="font-medium transition-colors duration-300" style={{color: themeStyles.textPrimary}}>
                                {category.avgResponseTime > 0 ? formatResponseTime(category.avgResponseTime) : 'N/A'}
                              </span>
                            </span>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                </>
              ) : (
                <div className="text-center py-12">
                  <BarChart3 className="w-16 h-16 mx-auto mb-4 opacity-50 transition-colors duration-300" style={{color: themeStyles.textMuted}} />
                  <p className="text-lg transition-colors duration-300" style={{color: themeStyles.textPrimary}}>No data available</p>
                  <p className="transition-colors duration-300" style={{color: themeStyles.textSecondary}}>Lead data will appear here once you have conversations</p>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Rest of your existing content */}
        {(activeTab === 'inbox' || activeTab === 'all' || activeTab === 'need_response' || activeTab === 'recently_sent') && (
          <>
      {/* Animated Background Gradient */}
      <div className="absolute inset-0 opacity-30 pointer-events-none">
        <div 
          className="absolute inset-0 animate-pulse" 
          style={{
            background: `radial-gradient(circle at 20% 50%, rgba(84, 252, 255, 0.1) 0%, transparent 50%), 
                        radial-gradient(circle at 80% 20%, rgba(34, 197, 94, 0.08) 0%, transparent 50%), 
                        radial-gradient(circle at 40% 80%, rgba(168, 85, 247, 0.06) 0%, transparent 50%)`,
            animation: 'gradientShift 8s ease-in-out infinite'
          }}
        />
      </div>

      {/* Floating Particles */}
      <div className="absolute inset-0 pointer-events-none overflow-hidden">
        {[...Array(6)].map((_, i) => (
          <div
            key={i}
            className="absolute w-1 h-1 rounded-full opacity-20"
            style={{
              backgroundColor: '#54FCFF',
              left: `${Math.random() * 100}%`,
              top: `${Math.random() * 100}%`,
              animation: `float ${4 + Math.random() * 4}s ease-in-out infinite`,
              animationDelay: `${Math.random() * 4}s`
            }}
          />
        ))}
      </div>

      {/* Sidebar - Lead List */}
      <div className="w-1/2 flex flex-col shadow-lg relative z-10 transition-colors duration-300" style={{backgroundColor: themeStyles.secondaryBg, borderRadius: '12px', margin: '8px', marginRight: '4px', backdropFilter: 'blur(10px)', border: `1px solid ${themeStyles.border}`}}>
        {/* Header with Metrics */}
        <div className="p-6 relative transition-colors duration-300" style={{backgroundColor: themeStyles.tertiaryBg, borderRadius: '12px 12px 0 0', borderBottom: `1px solid ${themeStyles.border}`}}>
          {/* Glowing accent line */}
                <div className="absolute top-0 left-1/2 transform -translate-x-1/2 w-20 h-0.5 rounded-full" style={{background: `linear-gradient(90deg, transparent, ${themeStyles.accent}, transparent)`, animation: 'glow 2s ease-in-out infinite alternate'}} />
          <div className="flex justify-between items-center mb-4">
            <h1 className="text-2xl font-bold relative transition-colors duration-300" style={{color: themeStyles.textPrimary}}>
              Inbox Manager
              <div className="absolute -bottom-1 left-0 w-full h-0.5 bg-gradient-to-r from-transparent to-transparent opacity-50" style={{background: `linear-gradient(90deg, transparent, ${themeStyles.accent}, transparent)`}} />
            </h1>
            <button
              onClick={() => setShowMetrics(!showMetrics)}
              className="text-sm transition-all duration-300 hover:scale-105 relative group"
              style={{color: themeStyles.accent}}
            >
              <span className="relative z-10">{showMetrics ? 'Hide' : 'Show'} Metrics</span>
              <div className="absolute inset-0 rounded opacity-0 group-hover:opacity-20 transition-opacity duration-300" style={{backgroundColor: themeStyles.accent}} />
            </button>
          </div>

          {/* Dashboard Metrics with breathing animation */}
          {showMetrics && (
            <div className="grid grid-cols-3 gap-4 mb-6">
              <button
                onClick={() => handleUrgencyFilter('urgent-response')}
                className="p-6 rounded-xl shadow-lg backdrop-blur-sm flex-1 text-left hover:scale-105 transition-all duration-300 cursor-pointer relative group active:animate-gradient-flash"
                style={{backgroundColor: 'rgba(239, 68, 68, 0.5)'}}
              >
                <div className="absolute inset-0 bg-red-400 rounded-xl opacity-0 group-hover:opacity-20 group-active:opacity-40 transition-opacity duration-300" />
                <div className="relative z-10">
                  <div className="flex items-center gap-2 mb-2">
                    <AlertCircle className="w-4 h-4" style={{color: themeStyles.textPrimary}} />
                    <span className="font-bold text-sm" style={{color: themeStyles.textPrimary}}>🚨 URGENT</span>
                    {activeFilters.urgency?.includes('urgent-response') && (
                      <span className="text-xs px-2 py-1 rounded-full" style={{backgroundColor: `${themeStyles.textPrimary}20`, color: themeStyles.textPrimary}}>ACTIVE</span>
                    )}
                  </div>
                  <div className="text-2xl font-bold" style={{color: themeStyles.textPrimary}}>
                    {leads.filter(lead => getResponseUrgency(lead) === 'urgent-response').length}
                  </div>
                  <div className="text-xs mt-1" style={{color: themeStyles.textSecondary}}>Needs immediate response (2+ days)</div>
                </div>
              </button>

              <button
                onClick={() => handleUrgencyFilter('needs-response')}
                className="p-6 rounded-xl shadow-lg backdrop-blur-sm flex-1 text-left hover:scale-105 transition-all duration-300 cursor-pointer relative group active:animate-gradient-flash"
                style={{backgroundColor: 'rgba(234, 179, 8, 0.5)'}}
              >
                <div className="absolute inset-0 bg-yellow-400 rounded-xl opacity-0 group-hover:opacity-20 group-active:opacity-40 transition-opacity duration-300" />
                <div className="relative z-10">
                  <div className="flex items-center gap-2 mb-2">
                    <Users className="w-4 h-4" style={{color: themeStyles.textPrimary}} />
                    <span className="font-bold text-sm" style={{color: themeStyles.textPrimary}}>⚡ NEEDS RESPONSE</span>
                    {activeFilters.urgency?.includes('needs-response') && (
                      <span className="text-xs px-2 py-1 rounded-full" style={{backgroundColor: `${themeStyles.textPrimary}20`, color: themeStyles.textPrimary}}>ACTIVE</span>
                    )}
                  </div>
                  <div className="text-2xl font-bold" style={{color: themeStyles.textPrimary}}>
                    {leads.filter(lead => getResponseUrgency(lead) === 'needs-response').length}
                  </div>
                  <div className="text-xs mt-1" style={{color: themeStyles.textSecondary}}>They replied, awaiting your response</div>
                </div>
              </button>

              <button
                onClick={() => handleUrgencyFilter('needs-followup')}
                className="p-6 rounded-xl shadow-lg backdrop-blur-sm flex-1 text-left hover:scale-105 transition-all duration-300 cursor-pointer relative group active:animate-gradient-flash"
                style={{backgroundColor: 'rgba(34, 197, 94, 0.5)'}}
              >
                <div className="absolute inset-0 bg-green-400 rounded-xl opacity-0 group-hover:opacity-20 group-active:opacity-40 transition-opacity duration-300" />
                <div className="relative z-10">
                  <div className="flex items-center gap-2 mb-2">
                    <Target className="w-4 h-4" style={{color: themeStyles.textPrimary}} />
                    <span className="font-bold text-sm" style={{color: themeStyles.textPrimary}}>📞 NEEDS FOLLOWUP</span>
                    {activeFilters.urgency?.includes('needs-followup') && (
                      <span className="text-xs px-2 py-1 rounded-full" style={{backgroundColor: `${themeStyles.textPrimary}20`, color: themeStyles.textPrimary}}>ACTIVE</span>
                    )}
                  </div>
                  <div className="text-2xl font-bold" style={{color: themeStyles.textPrimary}}>
                    {leads.filter(lead => getResponseUrgency(lead) === 'needs-followup').length}
                  </div>
                  <div className="text-xs mt-1" style={{color: themeStyles.textSecondary}}>You sent last, no reply 3+ days</div>
                </div>
              </button>
            </div>
          )}
          
          {/* Search */}
          <div className="relative mb-6">
            <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 transition-colors duration-300" style={{color: themeStyles.accent}} />
            <input
              type="text"
              placeholder="Search leads, tags, emails..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full pl-10 pr-4 py-2 rounded-lg backdrop-blur-sm focus:ring-2 transition-colors duration-300"
              style={{
                backgroundColor: themeStyles.tertiaryBg, 
                border: `1px solid ${themeStyles.border}`, 
                color: themeStyles.textPrimary,
                '--tw-ring-color': themeStyles.accent
              }}
            />
          </div>

          {/* Sort and Filter Buttons */}
          <div className="grid grid-cols-2 gap-3 mb-4">
            <div className="relative">
              <button
                onClick={() => setShowSortPopup(!showSortPopup)}
                className="w-full flex items-center justify-between px-4 py-2 rounded-lg hover:opacity-80 backdrop-blur-sm transition-all"
                style={{backgroundColor: themeStyles.tertiaryBg, border: `1px solid ${themeStyles.border}`}}
              >
                <div className="flex items-center gap-2">
                  <BarChart3 className="w-4 h-4" style={{color: themeStyles.accent}} />
                  <span className="text-sm font-medium" style={{color: themeStyles.textPrimary}}>Sort</span>
                  {activeSorts.length > 0 && (
                    <span className="px-2 py-1 rounded-full text-xs" style={{backgroundColor: `${themeStyles.accent}20`, color: themeStyles.accent}}>
                      {activeSorts.length}
                    </span>
                  )}
                </div>
                <ChevronDown className="w-4 h-4" style={{color: themeStyles.textMuted}} />
              </button>

              {/* Sort Popup */}
              {showSortPopup && (
                <div className="absolute top-full left-0 right-0 mt-2 rounded-lg shadow-lg z-50 max-h-96 overflow-y-auto transition-colors duration-300" style={{backgroundColor: themeStyles.secondaryBg, border: `1px solid ${themeStyles.border}`}}>
                  <div className="p-4">
                    <div className="flex justify-between items-center mb-3">
                      <h4 className="font-medium transition-colors duration-300" style={{color: themeStyles.textPrimary}}>Sort Options</h4>
                      <button
                        onClick={() => setShowSortPopup(false)}
                        className="transition-colors duration-300 hover:opacity-80"
                        style={{color: themeStyles.textMuted}}
                      >
                        <X className="w-4 h-4" />
                      </button>
                    </div>
                    
                    {/* Active Sorts */}
                    {activeSorts.length > 0 && (
                      <div className="mb-4">
                        <h5 className="text-xs font-medium mb-2 transition-colors duration-300" style={{color: themeStyles.textSecondary}}>ACTIVE SORTS</h5>
                        <div className="space-y-2">
                          {activeSorts.map((sort, index) => {
                            const option = sortOptions.find(opt => opt.field === sort.field);
                            return (
                              <div key={sort.field} className="flex items-center justify-between px-3 py-2 rounded-lg transition-colors duration-300" style={{backgroundColor: `${themeStyles.accent}20`, border: `1px solid ${themeStyles.accent}`}}>
                                <div className="flex items-center gap-2">
                                  <span className="text-xs px-2 py-1 rounded transition-colors duration-300" style={{backgroundColor: themeStyles.accent, color: isDarkMode ? '#1A1C1A' : '#FFFFFF'}}>
                                    {index + 1}
                                  </span>
                                  <span className="text-sm transition-colors duration-300" style={{color: themeStyles.textPrimary}}>{option?.label}</span>
                                  <button
                                    onClick={() => handleAddSort(sort.field, sort.direction === 'desc' ? 'asc' : 'desc')}
                                    className="text-xs hover:opacity-80 transition-colors duration-300"
                                    style={{color: themeStyles.accent}}
                                  >
                                    {sort.direction === 'desc' ? '↓' : '↑'}
                                  </button>
                                </div>
                                <button
                                  onClick={() => handleRemoveSort(sort.field)}
                                  className="hover:opacity-80 transition-colors duration-300"
                                  style={{color: themeStyles.textMuted}}
                                >
                                  <X className="w-3 h-3" />
                                </button>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    )}

                    {/* Available Sort Options */}
                    <div>
                      <h5 className="text-xs font-medium mb-2 transition-colors duration-300" style={{color: themeStyles.textSecondary}}>ADD SORT</h5>
                      <div className="space-y-1">
                        {sortOptions.map((option) => {
                          const isActive = activeSorts.some(s => s.field === option.field);
                          return (
                            <button
                              key={option.field}
                              onClick={() => !isActive && handleAddSort(option.field)}
                              disabled={isActive}
                              className={`w-full text-left px-3 py-2 rounded-lg text-sm transition-colors duration-300`}
                              style={{
                                backgroundColor: themeStyles.tertiaryBg,
                                color: isActive ? themeStyles.textMuted : themeStyles.textPrimary,
                                cursor: isActive ? 'not-allowed' : 'pointer'
                              }}
                            >
                              {option.label}
                              {isActive && <span className="text-xs ml-2" style={{color: themeStyles.textMuted}}>(active)</span>}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </div>

            <div className="relative">
              <button
                onClick={() => setShowFilterPopup(!showFilterPopup)}
                className="w-full flex items-center justify-between px-4 py-2 rounded-lg hover:opacity-80 backdrop-blur-sm transition-all"
                style={{backgroundColor: themeStyles.tertiaryBg, border: `1px solid ${themeStyles.border}`}}
              >
                <div className="flex items-center gap-2">
                  <Filter className="w-4 h-4" style={{color: themeStyles.accent}} />
                  <span className="text-sm font-medium" style={{color: themeStyles.textPrimary}}>Filter</span>
                  {getActiveFilterCount() > 0 && (
                    <span className="px-2 py-1 rounded-full text-xs" style={{backgroundColor: `${themeStyles.accent}20`, color: themeStyles.accent}}>
                      {getActiveFilterCount()}
                    </span>
                  )}
                </div>
                <ChevronDown className="w-4 h-4" style={{color: themeStyles.textMuted}} />
              </button>

                              {/* Filter Popup */}
                {showFilterPopup && (
                  <div className="absolute top-full left-0 right-0 mt-2 rounded-lg shadow-lg z-50 max-h-96 overflow-y-auto transition-colors duration-300" style={{backgroundColor: themeStyles.secondaryBg, border: `1px solid ${themeStyles.border}`, backdropFilter: 'none'}}>
                    <div className="p-4">
                      <div className="flex justify-between items-center mb-3">
                        <h4 className="font-medium transition-colors duration-300" style={{color: themeStyles.textPrimary}}>Filter Options</h4>
                        <div className="flex gap-2">
                          {getActiveFilterCount() > 0 && (
                            <button
                              onClick={handleClearAllFilters}
                              className="text-xs transition-colors duration-300"
                              style={{color: themeStyles.error}}
                            >
                              Clear All
                            </button>
                          )}
                          <button
                            onClick={() => setShowFilterPopup(false)}
                            className="transition-colors duration-300 hover:opacity-80"
                            style={{color: themeStyles.textMuted}}
                          >
                            <X className="w-4 h-4" />
                          </button>
                        </div>
                      </div>

                      {/* Active Filters */}
                      {getActiveFilterCount() > 0 && (
                        <div className="mb-4">
                          <h5 className="text-xs font-medium mb-2 transition-colors duration-300" style={{color: themeStyles.textSecondary}}>ACTIVE FILTERS</h5>
                          <div className="flex flex-wrap gap-2">
                            {Object.entries(activeFilters).map(([category, values]) =>
                              (values || []).map((value) => {
                                const categoryOption = filterOptions[category];
                                const valueOption = categoryOption?.options.find(opt => opt.value === value);
                                if (!valueOption) return null;
                                
                                return (
                                  <span
                                    key={`${category}-${value}`}
                                    className="inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs"
                                    style={{backgroundColor: themeStyles.accent, color: isDarkMode ? '#1A1C1A' : '#FFFFFF'}}
                                  >
                                    {valueOption.label}
                                    <button
                                      onClick={() => handleRemoveFilter(category, value)}
                                      className="hover:opacity-80"
                                    >
                                      <X className="w-3 h-3" />
                                    </button>
                                  </span>
                                );
                              })
                            )}
                          </div>
                        </div>
                      )}

                      {/* Filter Categories */}
                      <div className="space-y-4">
                        {Object.entries(filterOptions).map(([category, config]) => (
                          <div key={category}>
                            <h5 className="text-xs font-medium mb-2 uppercase transition-colors duration-300" style={{color: themeStyles.textSecondary}}>
                              {config.label}
                            </h5>
                            <div className="space-y-1">
                              {config.options.map((option) => {
                                const isActive = activeFilters[category]?.includes(option.value);
                                return (
                                  <button
                                    key={option.value}
                                    onClick={() => {
                                      if (isActive) {
                                        handleRemoveFilter(category, option.value);
                                      } else {
                                        handleAddFilter(category, option.value);
                                      }
                                    }}
                                    className={`w-full text-left px-3 py-2 rounded-lg text-sm transition-colors duration-300`}
                                    style={{
                                      backgroundColor: isActive ? `${themeStyles.accent}20` : themeStyles.tertiaryBg,
                                      color: themeStyles.textPrimary,
                                      border: isActive ? `1px solid ${themeStyles.accent}` : `1px solid ${themeStyles.border}`
                                    }}
                                  >
                                    <div className="flex items-center justify-between">
                                      {option.label}
                                      {isActive && <span style={{color: themeStyles.accent}}>✓</span>}
                                    </div>
                                  </button>
                                );
                              })}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                )}
            </div>
          </div>

          {/* Response Status Tabs */}
          <div className="flex gap-2 mb-6">
            <button
              onClick={() => setActiveTab('all')}
              className={`px-4 py-2 rounded-lg text-sm font-medium transition-all backdrop-blur-sm ${
                activeTab === 'all'
                  ? 'opacity-100' 
                  : 'opacity-80 hover:opacity-90'
              }`}
              style={{
                backgroundColor: activeTab === 'all' ? `${themeStyles.accent}20` : themeStyles.tertiaryBg, 
                color: activeTab === 'all' ? themeStyles.accent : themeStyles.textPrimary, 
                border: `1px solid ${themeStyles.border}`
              }}
              disabled={loading}
            >
              {loading ? (
                <div className="flex items-center gap-2">
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Loading...
                </div>
              ) : (
                'All Leads'
              )}
            </button>
            <button
              onClick={() => setActiveTab('need_response')}
              className={`px-4 py-2 rounded-lg text-sm font-medium transition-all backdrop-blur-sm ${
                activeTab === 'need_response'
                  ? 'opacity-100'
                  : 'opacity-80 hover:opacity-90'
              }`}
              style={{
                backgroundColor: activeTab === 'need_response' ? `${themeStyles.accent}20` : themeStyles.tertiaryBg, 
                color: activeTab === 'need_response' ? themeStyles.accent : themeStyles.textPrimary, 
                border: `1px solid ${themeStyles.border}`
              }}
              disabled={loading}
            >
              {loading ? (
                <div className="flex items-center gap-2">
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Loading...
                </div>
              ) : (
                <>
                  Need Response
                  {activeTab !== 'need_response' && (
                    <span className="ml-2 px-2 py-1 rounded-full text-xs" style={{backgroundColor: themeStyles.tertiaryBg, color: themeStyles.textMuted}}>
                      {leads.filter(lead => checkNeedsReply(lead.conversation)).length}
                    </span>
                  )}
                </>
              )}
            </button>
            <button
              onClick={() => setActiveTab('recently_sent')}
              className={`px-4 py-2 rounded-lg text-sm font-medium transition-all backdrop-blur-sm ${
                activeTab === 'recently_sent'
                  ? 'opacity-100'
                  : 'opacity-80 hover:opacity-90'
              }`}
              style={{
                backgroundColor: activeTab === 'recently_sent' ? `${themeStyles.accent}20` : themeStyles.tertiaryBg, 
                color: activeTab === 'recently_sent' ? themeStyles.accent : themeStyles.textPrimary, 
                border: `1px solid ${themeStyles.border}`
              }}
              disabled={loading}
            >
              {loading ? (
                <div className="flex items-center gap-2">
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Loading...
                </div>
              ) : (
                <>
                  Recently Sent
                  {activeTab !== 'recently_sent' && (
                    <span className="ml-2 px-2 py-1 rounded-full text-xs" style={{backgroundColor: themeStyles.tertiaryBg, color: themeStyles.textMuted}}>
                      {leads.filter(lead => {
                        if (lead.conversation.length === 0) return false;
                        const lastMessage = lead.conversation[lead.conversation.length - 1];
                        const timeSinceLastMessage = Math.floor((new Date() - new Date(lastMessage.time)) / (1000 * 60 * 60));
                        return lastMessage.type === 'SENT' && timeSinceLastMessage <= 24;
                      }).length}
                    </span>
                  )}
                </>
              )}
            </button>
          </div>


        </div>

        {/* Lead List */}
        <div className="flex-1 overflow-y-auto overflow-x-hidden" style={{scrollbarWidth: 'thin', scrollbarColor: '#54FCFF rgba(26, 28, 26, 0.5)', minHeight: 0}}>
          <div className="pb-4">
            {filteredAndSortedLeads.length === 0 ? (
              <div className="text-center p-8 text-white">
                <p>No leads found for current filter</p>
              </div>
            ) : null}
            {filteredAndSortedLeads.map((lead, index) => {
            try {
              const intentStyle = getIntentStyle(lead.intent);
              const lastMessage = lead.conversation && lead.conversation.length > 0 ? lead.conversation[lead.conversation.length - 1] : null;
              const urgency = getResponseUrgency(lead);
              const displayTags = generateAutoTags(lead.conversation, lead);
            
            // Get the response badge for top of card
            const getResponseBadge = () => {
              if (urgency === 'urgent-response') {
                return (
                  <div className="bg-red-600 text-white px-4 py-2 rounded-full text-xs font-bold mb-3 shadow-lg relative overflow-hidden">
                    <div className="absolute inset-0 bg-white opacity-20 animate-pulse" />
                    <span className="relative z-10">🚨 URGENT NEEDS RESPONSE</span>
                  </div>
                );
              } else if (urgency === 'needs-response') {
                return (
                  <div className="bg-red-500 text-white px-4 py-2 rounded-full text-xs font-medium mb-3 shadow-md relative overflow-hidden">
                    <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white to-transparent opacity-10 transform -skew-x-12 animate-shimmer" />
                    <span className="relative z-10">⚡ NEEDS RESPONSE</span>
                  </div>
                );
              } else if (urgency === 'needs-followup') {
                return (
                  <div className="bg-green-600 text-white px-4 py-2 rounded-full text-xs font-medium mb-3 shadow-md relative overflow-hidden">
                    <div className="absolute inset-0 bg-white opacity-10 animate-pulse" />
                    <span className="relative z-10">📞 NEEDS FOLLOWUP</span>
                  </div>
                );
              }
              return null;
            };
            
            return (
              <div
                key={lead.id}
                onClick={() => setSelectedLead(lead)}
                className={`p-5 cursor-pointer transition-all duration-300 ease-out relative m-2 rounded-lg group`}
                style={{
                  backgroundColor: selectedLead?.id === lead.id ? `${themeStyles.accent}20` : themeStyles.tertiaryBg,
                  border: selectedLead?.id === lead.id ? `2px solid ${themeStyles.accent}80` : `1px solid ${themeStyles.border}`,
                  borderLeft: urgency !== 'none' ? `4px solid ${themeStyles.accent}` : `1px solid ${themeStyles.border}`,
                  boxShadow: selectedLead?.id === lead.id ? `0 0 30px ${themeStyles.accent}30` : 'none',
                  animationDelay: `${index * 0.1}s`,
                  backdropFilter: 'blur(5px)'
                }}
              >
                {/* Hover glow effect */}
                <div className="absolute inset-0 rounded-lg opacity-0 group-hover:opacity-100 transition-opacity duration-300 pointer-events-none" 
                     style={{background: `linear-gradient(45deg, ${themeStyles.accent}10 0%, ${themeStyles.accent}05 100%)`}} />
                
                <div className="relative z-10">
                  {/* Response Badge at Top */}
                  {getResponseBadge()}
                  
                  <div className="flex justify-between items-start mb-2">
                    <h3 className={`transition-all duration-300 ${urgency !== 'none' ? 'font-bold' : 'font-medium'} flex items-center gap-2`}
                        style={{color: selectedLead?.id === lead.id ? themeStyles.accent : themeStyles.textPrimary}}>
                      <span>{lead.first_name} {lead.last_name}</span>
                      {urgency !== 'none' && <span className="text-sm animate-pulse" style={{color: themeStyles.error}}>●</span>}
                      {drafts[lead.id] && (
                        <span 
                          className="px-2 py-1 text-xs rounded-full transition-all duration-300 flex items-center gap-1"
                          style={{backgroundColor: `${themeStyles.warning}20`, border: `1px solid ${themeStyles.warning}`, color: themeStyles.warning}}
                          title="Has unsaved draft"
                        >
                          <Edit3 className="w-3 h-3" />
                          Draft
                        </span>
                      )}
                    </h3>
                    <div className="flex items-center gap-1">
                      <span className="px-2 py-1 text-xs rounded-full transition-all duration-300 transform group-hover:scale-110" 
                            style={{backgroundColor: `${themeStyles.accent}15`, border: `1px solid ${themeStyles.border}`, color: themeStyles.textPrimary}}>
                        {lead.intent}
                      </span>
                    </div>
                  </div>
                  
                  <p className="text-sm mb-1 transition-colors duration-300" style={{color: themeStyles.textSecondary}}>{lead.email}</p>
                  <p className={`text-sm mb-2 transition-all duration-300 ${urgency !== 'none' ? 'font-bold' : 'font-medium'}`}
                     style={{color: selectedLead?.id === lead.id ? themeStyles.accent : themeStyles.textPrimary}}>
                    {lead.subject}
                  </p>
                  
                  {/* Enhanced metadata with animations */}
                  <div className="flex items-center gap-3 text-xs mb-2" style={{color: themeStyles.textSecondary}}>
                    <span className={`font-medium transition-all duration-300 group-hover:scale-105`} style={{color: getEngagementColor(lead.engagement_score)}}>
                      {lead.engagement_score}% engagement
                    </span>
                    <span className="transition-all duration-300 group-hover:scale-105" style={{color: themeStyles.accent}}>
                      {lead.conversation.filter(m => m.type === 'REPLY').length} replies
                    </span>
                    {urgency !== 'none' && lastMessage && (
                      <span className="font-bold animate-pulse transition-all duration-300 group-hover:scale-105" style={{color: themeStyles.error}}>
                        {Math.floor((new Date() - new Date(lastMessage.time)) / (1000 * 60 * 60 * 24))} days
                      </span>
                    )}
                  </div>
                  
                  {/* Tags with staggered animations */}
                  <div className="flex flex-wrap gap-2 mb-3">
                    {displayTags.slice(0, 3).map((tag, tagIndex) => (
                      <span key={tag} 
                            className="text-xs px-3 py-1 rounded-full transition-all duration-300 transform hover:scale-110" 
                            style={{
                              backgroundColor: `${themeStyles.accent}15`, 
                              color: themeStyles.textPrimary, 
                              border: `1px solid ${themeStyles.border}`,
                              animation: `tagFadeIn 0.5s ease-out ${(index * 0.1) + (tagIndex * 0.1)}s both`
                            }}>
                        {tag}
                      </span>
                    ))}
                    {displayTags.length > 3 && (
                      <span className="text-xs transition-colors duration-300" style={{color: themeStyles.textSecondary}}>+{displayTags.length - 3}</span>
                    )}
                  </div>
                  
                  <div className="flex items-center justify-between text-xs" style={{color: themeStyles.textSecondary}}>
                    <div className="flex items-center gap-3">
                      <div className="flex items-center transition-all duration-300">
                        <Timer className="w-3 h-3 mr-1 transition-transform duration-300 group-hover:rotate-12" />
                        Last followup: {(() => {
                          const lastSent = lead.conversation.filter(m => m.type === 'SENT');
                          if (lastSent.length === 0) return 'N/A';
                          const daysSince = Math.floor((new Date() - new Date(lastSent[lastSent.length - 1].time)) / (1000 * 60 * 60 * 24));
                          return `${daysSince}d ago`;
                        })()}
                      </div>
                      <div className="flex items-center transition-all duration-300">
                        <Clock className="w-3 h-3 mr-1 transition-transform duration-300 group-hover:rotate-12" />
                        Last reply: {(() => {
                          const lastReply = getLastResponseFromThem(lead.conversation);
                          if (!lastReply) return 'None';
                          const daysSince = Math.floor((new Date() - new Date(lastReply)) / (1000 * 60 * 60 * 24));
                          return `${daysSince}d ago`;
                        })()}
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="px-3 py-1 rounded-full text-xs transition-all duration-300 transform group-hover:scale-105" 
                            style={{backgroundColor: themeStyles.tertiaryBg, border: `1px solid ${themeStyles.border}`, color: themeStyles.textPrimary}}>
                        {lead.conversation.length} messages
                      </span>
                    </div>
                  </div>
                </div>
              </div>
            );
            } catch (error) {
              console.error('Error rendering lead:', lead.first_name, error);
              return (
                <div key={lead.id || index} className="p-4 m-2 bg-red-500/20 text-white rounded">
                  Error rendering {lead.first_name || 'Unknown'}: {error.message}
                </div>
              );
            }
          })}
          </div>
        </div>
      </div>

      {/* Main Content - Lead Details */}
      <div className="flex-1 flex flex-col shadow-lg transition-colors duration-300" style={{backgroundColor: themeStyles.secondaryBg, borderRadius: '12px', margin: '8px', marginLeft: '4px', border: `1px solid ${themeStyles.border}`}}>
        {selectedLead ? (
          <>
            {/* Lead Header */}
            <div className="p-8 transition-colors duration-300" style={{backgroundColor: themeStyles.tertiaryBg, borderRadius: '12px 12px 0 0', borderBottom: `1px solid ${themeStyles.border}`}}>
              <div className="flex justify-between items-start">
                <div>
                  <h2 className="text-3xl font-bold transition-colors duration-300" style={{color: themeStyles.textPrimary}}>
                    {selectedLead.first_name} {selectedLead.last_name}
                  </h2>
                  <p className="mt-2 font-medium transition-colors duration-300" style={{color: themeStyles.textSecondary}}>{selectedLead.email}</p>
                  {selectedLead.phone ? (
                    <p className="text-sm mt-2 flex items-center gap-2 transition-colors duration-300" style={{color: themeStyles.accent}}>
                      <Phone className="w-3 h-3" />
                      <span className="font-medium">{selectedLead.phone}</span>
                    </p>
                  ) : (
                    <p className="text-sm mt-2 flex items-center gap-2 transition-colors duration-300" style={{color: themeStyles.textMuted}}>
                      <Phone className="w-3 h-3" />
                      <span>No phone number found</span>
                    </p>
                  )}
                  {selectedLead.website && (
                    <p className="text-sm mt-2">
                      <a href={`https://${selectedLead.website}`} target="_blank" rel="noopener noreferrer" className="flex items-center gap-2 hover:opacity-80 transition-colors duration-300" style={{color: themeStyles.accent}}>
                        {selectedLead.website}
                        <ExternalLink className="w-3 h-3" />
                      </a>
                    </p>
                  )}
                </div>
                <div className="flex items-center gap-4">
                  {(() => {
                    const intentStyle = getIntentStyle(selectedLead.intent);
                    return (
                      <span className="px-3 py-1 rounded-full text-sm font-medium transition-colors duration-300" style={{backgroundColor: `${themeStyles.accent}15`, border: `1px solid ${themeStyles.border}`, color: themeStyles.textPrimary}}>
                        {intentStyle.label} ({selectedLead.intent}/10)
                      </span>
                    );
                  })()}
                  <button
                    onClick={() => showDeleteConfirmation(selectedLead)}
                    className="px-3 py-2 rounded-lg transition-colors duration-300 flex items-center gap-2 text-sm hover:opacity-80"
                    title="Delete lead"
                    style={{border: `1px solid ${themeStyles.border}`, backgroundColor: themeStyles.tertiaryBg, color: themeStyles.textPrimary}}
                  >
                    <X className="w-4 h-4" />
                    Delete
                  </button>
                  <button
                    onClick={() => setSelectedLead(null)}
                    className="p-2 rounded-lg transition-colors duration-300 hover:opacity-80"
                    style={{border: `1px solid ${themeStyles.border}`, backgroundColor: themeStyles.tertiaryBg, color: themeStyles.textMuted}}
                  >
                    <X className="w-5 h-5" />
                  </button>
                </div>
              </div>
            </div>

            {/* Content */}
            <div className="flex-1 overflow-y-auto p-8 transition-colors duration-300" style={{scrollbarWidth: 'thin', scrollbarColor: `${themeStyles.accent} ${themeStyles.primaryBg}50`}}>
              <div className="space-y-8">
                      {/* Unified Lead Information Section */}
                <div className="rounded-2xl p-6 shadow-lg transition-colors duration-300" style={{backgroundColor: themeStyles.tertiaryBg, border: `1px solid ${themeStyles.border}`}}>
                        <div className="flex justify-between items-center mb-6">
                          <h3 className="font-bold flex items-center text-lg transition-colors duration-300" style={{color: themeStyles.textPrimary}}>
                    <User className="w-4 h-4 mr-2 transition-colors duration-300" style={{color: themeStyles.accent}} />
                    Lead Information
                  </h3>
                          <div className="flex items-center gap-2">
                            <button
                              onClick={() => findPhoneNumber(selectedLead)}
                              disabled={searchingPhoneLeads.has(selectedLead.id)}
                              className="px-4 py-2 rounded-lg text-sm font-medium transition-all backdrop-blur-sm hover:opacity-80 disabled:opacity-50 flex items-center gap-2"
                              style={{backgroundColor: `${themeStyles.accent}20`, color: themeStyles.accent, border: `1px solid ${themeStyles.accent}30`}}
                            >
                              {searchingPhoneLeads.has(selectedLead.id) ? (
                                <>
                                  <div className="animate-spin rounded-full h-4 w-4 border-b-2" style={{borderColor: themeStyles.accent}} />
                                  Searching...
                                </>
                              ) : (
                                <>
                                  <Phone className="w-4 h-4" />
                                  Find Phone
                                </>
                              )}
                            </button>
                            <button
                              onClick={() => enrichLeadData(selectedLead)}
                              disabled={enrichingLeads.has(selectedLead.id)}
                              className="px-4 py-2 rounded-lg text-sm font-medium transition-all backdrop-blur-sm hover:opacity-80 disabled:opacity-50 flex items-center gap-2"
                              style={{backgroundColor: `${themeStyles.accent}20`, color: themeStyles.accent, border: `1px solid ${themeStyles.accent}30`}}
                            >
                              {enrichingLeads.has(selectedLead.id) ? (
                                <>
                                  <div className="animate-spin rounded-full h-4 w-4 border-b-2" style={{borderColor: themeStyles.accent}} />
                                  Enriching...
                                </>
                              ) : (
                                <>
                                  <Zap className="w-4 h-4" />
                                  Enrich
                                </>
                              )}
                            </button>
                          </div>
                        </div>

                        {/* Communication Timeline */}
                        <div className="mb-6 p-4 rounded-lg transition-colors duration-300" style={{backgroundColor: themeStyles.tertiaryBg, border: `1px solid ${themeStyles.border}`}}>
                          <div className="flex items-center justify-between text-sm">
                            <div className="flex items-center gap-6">
                              <div>
                                <span className="transition-colors duration-300" style={{color: themeStyles.textMuted}}>Last Reply</span>
                                <p className="font-medium mt-1 transition-colors duration-300" style={{color: themeStyles.textPrimary}}>
                                  {(() => {
                                    const lastReply = getLastResponseFromThem(selectedLead.conversation);
                                    return lastReply ? formatTime(lastReply) : 'No replies yet';
                                  })()}
                                </p>
                              </div>
                              <div>
                                <span className="transition-colors duration-300" style={{color: themeStyles.textMuted}}>Last Followup</span>
                                <p className="font-medium mt-1 transition-colors duration-300" style={{color: themeStyles.textPrimary}}>
                                  {(() => {
                                    const lastSent = selectedLead.conversation.filter(m => m.type === 'SENT');
                                    return lastSent.length > 0 ? formatTime(lastSent[lastSent.length - 1].time) : 'N/A';
                                  })()}
                                </p>
                              </div>
                              <div>
                                <span className="transition-colors duration-300" style={{color: themeStyles.textMuted}}>Avg Response</span>
                                <p className="font-medium mt-1 transition-colors duration-300" style={{color: themeStyles.textPrimary}}>{formatResponseTime(selectedLead.response_time_avg)}</p>
                              </div>
                            </div>
                            <div className="px-3 py-1 rounded-full text-sm transition-colors duration-300" style={{backgroundColor: `${themeStyles.accent}15`, border: `1px solid ${themeStyles.accent}20`}}>
                              <span className="font-medium transition-colors duration-300" style={{color: themeStyles.textPrimary}}>{selectedLead.conversation.filter(m => m.type === 'REPLY').length}</span>
                              <span className="transition-colors duration-300" style={{color: themeStyles.textMuted}}> replies</span>
                            </div>
                          </div>
                        </div>

                        <div className="space-y-2">
                          {/* General Info Subsection */}
                          <div className="rounded-lg overflow-hidden transition-all duration-200" style={{backgroundColor: themeStyles.tertiaryBg}}>
                            <button 
                              onClick={() => toggleSection('general')}
                              className="w-full px-4 py-3 flex items-center justify-between hover:opacity-80 transition-colors duration-300"
                            >
                              <div className="flex items-center gap-2">
                                <ChevronRight 
                                  className={`w-4 h-4 transition-transform duration-200 ${activeSection.includes('general') ? 'rotate-90' : ''}`} 
                                  style={{color: themeStyles.accent}} 
                                />
                                <span className="font-medium transition-colors duration-300" style={{color: themeStyles.textPrimary}}>General Information</span>
                              </div>
                            </button>
                            {activeSection.includes('general') && (
                              <div className="px-4 pb-4">
                                <div className="grid grid-cols-2 gap-4 text-sm pl-6">
                    <div>
                      <span className="transition-colors duration-300" style={{color: themeStyles.textSecondary}}>Subject:</span>
                      <p className="font-medium transition-colors duration-300" style={{color: themeStyles.textPrimary}}>{selectedLead.subject}</p>
                    </div>
                    <div>
                      <span className="transition-colors duration-300" style={{color: themeStyles.textSecondary}}>Website:</span>
                      <p className="font-medium">
                        {selectedLead.website ? (
                          <a href={`https://${selectedLead.website}`} target="_blank" rel="noopener noreferrer" className="hover:opacity-80 flex items-center gap-1 transition-colors duration-300" style={{color: themeStyles.accent}}>
                            {selectedLead.website}
                            <ExternalLink className="w-3 h-3" />
                          </a>
                        ) : <span className="transition-colors duration-300" style={{color: themeStyles.textPrimary}}>N/A</span>}
                      </p>
                    </div>
                    <div className="col-span-2">
                      <span className="transition-colors duration-300" style={{color: themeStyles.textSecondary}}>Tags:</span>
                      <div className="flex flex-wrap gap-1 mt-1">
                        {selectedLead.tags.map(tag => (
                          <span key={tag} className="text-xs px-2 py-1 rounded-full transition-colors duration-300" style={{backgroundColor: `${themeStyles.accent}15`, border: `1px solid ${themeStyles.border}`, color: themeStyles.textPrimary}}>
                            {tag}
                          </span>
                        ))}
                      </div>
                    </div>
                  </div>
                              </div>
                            )}
                </div>

                          {/* Enrichment Data Subsection */}
                          <div className="rounded-lg overflow-hidden transition-all duration-200" style={{backgroundColor: themeStyles.tertiaryBg}}>
                            <button 
                              onClick={() => toggleSection('enrichment')}
                              className="w-full px-4 py-3 flex items-center justify-between hover:opacity-80 transition-colors duration-300"
                            >
                              <div className="flex items-center gap-2">
                                <ChevronRight 
                                  className={`w-4 h-4 transition-transform duration-200 ${activeSection.includes('enrichment') ? 'rotate-90' : ''}`} 
                                  style={{color: themeStyles.accent}} 
                                />
                                <span className="font-medium transition-colors duration-300" style={{color: themeStyles.textPrimary}}>Enrichment Data</span>
                      </div>
                              {(!selectedLead.role && !selectedLead.company_data && !selectedLead.personal_linkedin_url && !selectedLead.business_linkedin_url) && (
                                <span className="text-xs transition-colors duration-300" style={{color: themeStyles.textMuted}}>No data yet</span>
                              )}
                            </button>
                            {activeSection.includes('enrichment') && (
                              <div className="px-4 pb-4">
                                {(!selectedLead.role && !selectedLead.company_data && !selectedLead.personal_linkedin_url && !selectedLead.business_linkedin_url) ? (
                                  <div className="text-center py-6 rounded-lg mx-6 transition-colors duration-300" style={{color: themeStyles.textMuted, border: `1px solid ${themeStyles.border}`}}>
                                    <Zap className="w-8 h-8 mx-auto mb-3 opacity-50" />
                                    <p className="text-sm">Click the Enrich button above to fetch additional data</p>
                      </div>
                                ) : (
                                  <div className="grid grid-cols-2 gap-4 text-sm pl-6">
                                    <div>
                                      <span className="transition-colors duration-300" style={{color: themeStyles.textSecondary}}>Role:</span>
                                      <p className="font-medium transition-colors duration-300" style={{color: themeStyles.textPrimary}}>{selectedLead.role || 'N/A'}</p>
                    </div>
                                    <div className="col-span-2">
                                      <span className="transition-colors duration-300" style={{color: themeStyles.textSecondary}}>Company Summary:</span>
                                      <p className="font-medium mt-1 transition-colors duration-300" style={{color: themeStyles.textPrimary}}>{selectedLead.company_data || 'N/A'}</p>
                      </div>
                                    <div>
                                      <span className="transition-colors duration-300" style={{color: themeStyles.textSecondary}}>Personal LinkedIn:</span>
                                      {selectedLead.personal_linkedin_url ? (
                                        <a
                                          href={selectedLead.personal_linkedin_url}
                                          target="_blank"
                                          rel="noopener noreferrer"
                                          className="font-medium hover:opacity-80 flex items-center gap-1 transition-colors duration-300"
                                          style={{color: themeStyles.accent}}
                                        >
                                          View Profile
                                          <ExternalLink className="w-3 h-3" />
                                        </a>
                                      ) : (
                                        <p className="font-medium transition-colors duration-300" style={{color: themeStyles.textPrimary}}>N/A</p>
                                      )}
                      </div>
                                    <div>
                                      <span className="transition-colors duration-300" style={{color: themeStyles.textSecondary}}>Company LinkedIn:</span>
                                      {selectedLead.business_linkedin_url ? (
                                        <a
                                          href={selectedLead.business_linkedin_url}
                                          target="_blank"
                                          rel="noopener noreferrer"
                                          className="font-medium hover:opacity-80 flex items-center gap-1 transition-colors duration-300"
                                          style={{color: themeStyles.accent}}
                                        >
                                          View Company
                                          <ExternalLink className="w-3 h-3" />
                                        </a>
                                      ) : (
                                        <p className="font-medium transition-colors duration-300" style={{color: themeStyles.textPrimary}}>N/A</p>
                                      )}
                    </div>
                                  </div>
                                )}
                              </div>
                            )}
                          </div>

                          {/* Engagement Metrics Subsection */}
                          <div className="rounded-lg overflow-hidden transition-all duration-200" style={{backgroundColor: themeStyles.tertiaryBg}}>
                            <button 
                              onClick={() => toggleSection('engagement')}
                              className="w-full px-4 py-3 flex items-center justify-between hover:opacity-80 transition-colors duration-300"
                            >
                              <div className="flex items-center gap-2">
                                <ChevronRight 
                                  className={`w-4 h-4 transition-transform duration-200 ${activeSection.includes('engagement') ? 'rotate-90' : ''}`} 
                                  style={{color: themeStyles.accent}} 
                                />
                                <span className="font-medium transition-colors duration-300" style={{color: themeStyles.textPrimary}}>Engagement Metrics</span>
                              </div>
                            </button>
                            {activeSection.includes('engagement') && (
                              <div className="px-4 pb-4">
                                <div className="grid grid-cols-3 gap-4 text-sm pl-6">
                                  <div className="col-span-3 p-4 rounded-lg transition-colors duration-300" style={{backgroundColor: themeStyles.tertiaryBg, border: `1px solid ${themeStyles.border}`}}>
                                    <div className="grid grid-cols-3 gap-8">
                                      <div>
                                        <span className="transition-colors duration-300" style={{color: themeStyles.textMuted}}>Avg Response Time</span>
                                        <p className="text-2xl font-bold mt-1 transition-colors duration-300" style={{color: themeStyles.textPrimary}}>
                                          {formatResponseTime(selectedLead.response_time_avg)}
                                        </p>
                                      </div>
                                      <div>
                                        <span className="transition-colors duration-300" style={{color: themeStyles.textMuted}}>Intent Score</span>
                                        <p className="text-2xl font-bold mt-1 transition-colors duration-300" style={{color: themeStyles.accent}}>
                                          {selectedLead.intent}/10
                                        </p>
                                      </div>
                                      <div>
                                        <span className="transition-colors duration-300" style={{color: themeStyles.textMuted}}>Reply Rate</span>
                                        <p className="text-2xl font-bold mt-1 transition-colors duration-300" style={{color: themeStyles.textPrimary}}>
                        {selectedLead.conversation.filter(msg => msg.type === 'REPLY').length}/{selectedLead.conversation.filter(msg => msg.type === 'SENT').length}
                                        </p>
                      </div>
                      </div>
                                  </div>
                                </div>
                              </div>
                            )}
                    </div>
                  </div>
                </div>

                {/* Conversation History */}
                <div className="rounded-2xl p-6 shadow-lg transition-colors duration-300" style={{backgroundColor: themeStyles.tertiaryBg, border: `1px solid ${themeStyles.border}`}}>
                  <h3 className="font-bold mb-4 flex items-center text-lg transition-colors duration-300" style={{color: themeStyles.textPrimary}}>
                    <MessageSquare className="w-4 h-4 mr-2 transition-colors duration-300" style={{color: themeStyles.accent}} />
                    Conversation History ({selectedLead.conversation.length} messages)
                  </h3>
                  <div className="space-y-6 max-h-96 overflow-y-auto" style={{scrollbarWidth: 'thin', scrollbarColor: `${themeStyles.accent} ${themeStyles.primaryBg}50`}}>
                                          {selectedLead.conversation.map((message, index) => (
                        <div key={index} className={`p-5 rounded-xl border shadow-sm transition-colors duration-300`} style={{
                          backgroundColor: message.type === 'SENT' 
                            ? `${themeStyles.accent}08` 
                            : themeStyles.tertiaryBg,
                          borderColor: message.type === 'SENT' 
                            ? `${themeStyles.accent}30` 
                            : themeStyles.border
                        }}>
                          <div className="flex justify-between items-start mb-2">
                            <div className="text-sm">
                              <span className={`font-medium transition-colors duration-300`} style={{color: message.type === 'SENT' ? themeStyles.accent : themeStyles.textPrimary}}>
                                {message.type === 'SENT' ? 'Outbound' : 'Reply'} 
                              </span>
                              <span className="ml-2 transition-colors duration-300" style={{color: themeStyles.textSecondary}}>
                                {formatTime(message.time)}
                              </span>
                              {message.response_time && (
                                <span className="ml-2 text-xs transition-colors duration-300" style={{color: themeStyles.success}}>
                                  • {formatResponseTime(message.response_time)} response
                                </span>
                              )}
                            </div>
                            <div className="flex items-center gap-2">
                              <span className={`px-2 py-1 text-xs rounded-full transition-colors duration-300`} style={{
                                backgroundColor: message.type === 'SENT' 
                                  ? `${themeStyles.accent}15` 
                                  : themeStyles.tertiaryBg,
                                border: `1px solid ${themeStyles.border}`,
                                color: message.type === 'SENT' ? themeStyles.accent : themeStyles.textPrimary
                              }}>
                                {message.type}
                              </span>
                            </div>
                          </div>

                          {/* Email routing information */}
                          <div className="mb-3 text-xs space-y-1 transition-colors duration-300" style={{color: themeStyles.textMuted}}>
                            <div className="flex flex-wrap gap-4">
                              <span><strong>From:</strong> {message.from || 'N/A'}</span>
                              <span><strong>To:</strong> {message.to || 'N/A'}</span>
                            </div>
                            {message.cc && Array.isArray(message.cc) && message.cc.length > 0 && (
                              <div>
                                <strong>CC:</strong> {message.cc.map(cc => {
                                  if (typeof cc === 'string') return cc;
                                  if (cc && cc.address) return cc.address;
                                  if (cc && cc.name && cc.name.trim() !== '') return cc.name;
                                  return '';
                                }).filter(Boolean).join(', ')}
                              </div>
                            )}
                            {message.subject && (
                              <div>
                                <strong>Subject:</strong> {message.subject}
                              </div>
                            )}
                          </div>

                          <div className="text-sm whitespace-pre-wrap leading-relaxed transition-colors duration-300" style={{color: themeStyles.textPrimary}}>
                            {message.content}
                          </div>
                        </div>
                      ))}
                  </div>
                </div>

                {/* Response Section */}
                <div className="rounded-2xl p-6 shadow-lg transition-colors duration-300" style={{backgroundColor: themeStyles.tertiaryBg, border: `1px solid ${themeStyles.border}`}}>
                  <div className="flex justify-between items-center mb-4">
                    <h3 className="font-bold flex items-center text-lg transition-colors duration-300" style={{color: themeStyles.textPrimary}}>
                      <Mail className="w-4 h-4 mr-2 transition-colors duration-300" style={{color: themeStyles.accent}} />
                      Compose Response
                    </h3>
                    {/* Draft Status Indicator */}
                    <div className="flex items-center gap-2 text-xs transition-colors duration-300" style={{color: themeStyles.textMuted}}>
                      {isDraftSaving && (
                        <span className="flex items-center gap-1">
                          <div className="animate-spin w-3 h-3 border border-t-transparent rounded-full" style={{borderColor: themeStyles.accent}} />
                          Saving draft...
                        </span>
                      )}
                      {selectedLead && drafts[selectedLead.id] && !isDraftSaving && (
                        <span className="flex items-center gap-1" style={{color: themeStyles.success}}>
                          <CheckCircle className="w-3 h-3" />
                          Draft saved {new Date(drafts[selectedLead.id].savedAt).toLocaleTimeString()}
                        </span>
                      )}
                    </div>
                  </div>
                  
                  <div className="space-y-6">
                    {/* Editable Email Recipients */}
                    <div className="p-4 rounded-lg transition-colors duration-300" style={{backgroundColor: themeStyles.tertiaryBg, border: `1px solid ${themeStyles.border}`}}>
                      <h4 className="font-medium mb-3 flex items-center text-sm transition-colors duration-300" style={{color: themeStyles.textPrimary}}>
                        <Mail className="w-4 h-4 mr-2 transition-colors duration-300" style={{color: themeStyles.accent}} />
                        Email Recipients
                      </h4>
                      <div className="grid grid-cols-1 gap-3">
                        <div>
                          <label className="text-xs block mb-1 transition-colors duration-300" style={{color: themeStyles.textSecondary}}>To:</label>
                          <input
                            type="email"
                            value={editableToEmail}
                            onChange={(e) => setEditableToEmail(e.target.value)}
                            className="w-full px-3 py-2 rounded-lg text-sm focus:ring-2 transition-colors duration-300"
                            style={{
                              backgroundColor: themeStyles.secondaryBg, 
                              border: `1px solid ${themeStyles.border}`, 
                              color: themeStyles.textPrimary,
                              '--tw-ring-color': themeStyles.accent
                            }}
                            placeholder="Primary recipient email"
                          />
                        </div>
                        <div>
                          <label className="text-xs block mb-1 transition-colors duration-300" style={{color: themeStyles.textSecondary}}>CC: (separate multiple emails with commas)</label>
                          <input
                            type="text"
                            value={editableCcEmails}
                            onChange={(e) => setEditableCcEmails(e.target.value)}
                            className="w-full px-3 py-2 rounded-lg text-sm focus:ring-2 transition-colors duration-300"
                            style={{
                              backgroundColor: themeStyles.secondaryBg, 
                              border: `1px solid ${themeStyles.border}`, 
                              color: themeStyles.textPrimary,
                              '--tw-ring-color': themeStyles.accent
                            }}
                            placeholder="CC recipients (optional)"
                          />
                        </div>
                        <div className="text-xs transition-colors duration-300" style={{color: themeStyles.textMuted}}>
                          Auto-populated based on conversation. Edit as needed before sending.
                        </div>
                      </div>
                    </div>

                    <div className="flex gap-3">
                      <button
                        onClick={generateDraft}
                        disabled={isGeneratingDraft}
                        className="px-4 py-2 rounded-lg hover:opacity-80 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2 transition-all duration-300"
                        style={{backgroundColor: themeStyles.accent, color: isDarkMode ? '#1A1C1A' : '#FFFFFF'}}
                      >
                        <Edit3 className="w-4 h-4" />
                        {isGeneratingDraft ? 'Generating...' : 'Generate Smart Draft'}
                      </button>
                    </div>

                    {/* Rich Text Editor with Formatting */}
                    <div className="space-y-3">
                      {/* Formatting Toolbar */}
                      <div className="flex flex-wrap gap-2 p-3 rounded-lg transition-colors duration-300" style={{backgroundColor: themeStyles.tertiaryBg, border: `1px solid ${themeStyles.border}`}}>
                        <button
                          type="button"
                          onClick={() => formatText('bold')}
                          className="px-3 py-1 rounded text-xs font-bold hover:opacity-80 transition-all duration-300"
                          style={{backgroundColor: themeStyles.tertiaryBg, color: themeStyles.textPrimary}}
                          title="Bold"
                        >
                          B
                        </button>
                        <button
                          type="button"
                          onClick={() => formatText('italic')}
                          className="px-3 py-1 rounded text-xs italic hover:opacity-80 transition-all duration-300"
                          style={{backgroundColor: themeStyles.tertiaryBg, color: themeStyles.textPrimary}}
                          title="Italic"
                        >
                          I
                        </button>
                        <button
                          type="button"
                          onClick={() => formatText('underline')}
                          className="px-3 py-1 rounded text-xs underline hover:opacity-80 transition-all duration-300"
                          style={{backgroundColor: themeStyles.tertiaryBg, color: themeStyles.textPrimary}}
                          title="Underline"
                        >
                          U
                        </button>
                        <button
                          type="button"
                          onClick={insertLink}
                          className="px-3 py-1 rounded text-xs hover:opacity-80 transition-all duration-300 flex items-center gap-1"
                          style={{backgroundColor: themeStyles.tertiaryBg, color: themeStyles.textPrimary}}
                          title="Insert Link"
                        >
                          🔗 Link
                        </button>
                        <button
                          type="button"
                          onClick={insertList}
                          className="px-3 py-1 rounded text-xs hover:opacity-80 transition-all duration-300"
                          style={{backgroundColor: themeStyles.tertiaryBg, color: themeStyles.textPrimary}}
                          title="Bullet List"
                        >
                          • List
                        </button>
                        <div className="mx-2" style={{borderLeft: `1px solid ${themeStyles.border}`}}></div>
                        <input
                          type="file"
                          multiple
                          accept=".pdf,.doc,.docx,.txt,.jpg,.jpeg,.png,.gif"
                          className="hidden"
                          id="attachment-input"
                        />
                        <label
                          htmlFor="attachment-input"
                          className="px-3 py-1 rounded text-xs hover:opacity-80 transition-all duration-300 cursor-pointer flex items-center gap-1"
                          style={{backgroundColor: themeStyles.tertiaryBg, color: themeStyles.textPrimary}}
                          title="Attach File"
                        >
                          📎 Attach
                        </label>
                      </div>

                      {/* Rich Text Editor */}
                      <div
                        contentEditable
                        suppressContentEditableWarning={true}
                        onInput={handleTextareaChange}
                        onKeyDown={(e) => {
                          // Handle common keyboard shortcuts
                          if (e.ctrlKey || e.metaKey) {
                            switch(e.key) {
                              case 'b':
                                e.preventDefault();
                                formatText('bold');
                                break;
                              case 'i':
                                e.preventDefault();
                                formatText('italic');
                                break;
                              case 'u':
                                e.preventDefault();
                                formatText('underline');
                                break;
                            }
                                } else if (e.key === 'Enter') {
                                  const selection = window.getSelection();
                                  if (selection.rangeCount > 0) {
                                    const range = selection.getRangeAt(0);
                                    let currentListItem = range.startContainer;
                                    
                                    // Navigate up to find the list item div
                                    while (currentListItem && (!currentListItem.style || currentListItem.style.position !== 'relative')) {
                                      currentListItem = currentListItem.parentNode;
                                    }
                                    
                                    // If we're in a list item
                                    if (currentListItem && currentListItem.style && currentListItem.style.position === 'relative') {
                                      e.preventDefault();
                                      
                                      // Check if current list item is empty (except for bullet)
                                      const textContent = currentListItem.textContent.replace('•', '').trim();
                                      
                                      if (textContent === '') {
                                        // Exit list if empty
                                        const newLine = document.createElement('div');
                                        newLine.innerHTML = '<br>';
                                        currentListItem.parentNode.replaceChild(newLine, currentListItem);
                                        
                                        // Place cursor in new line
                                        const newRange = document.createRange();
                                        newRange.setStart(newLine, 0);
                                        newRange.collapse(true);
                                        selection.removeAllRanges();
                                        selection.addRange(newRange);
                                      } else {
                                        // Create new bullet point
                                        const listItem = document.createElement('div');
                                        listItem.style.cssText = `
                                          position: relative;
                                          padding-left: 20px;
                                          margin: 4px 0;
                                          line-height: 1.5;
                                        `;
                                        
                                        const bullet = document.createElement('span');
                                        bullet.textContent = '•';
                                        bullet.style.cssText = `
                                          position: absolute;
                                          left: 4px;
                                          font-size: 1.2em;
                                          line-height: 1;
                                          top: 50%;
                                          transform: translateY(-50%);
                                        `;
                                        
                                        const textContent = document.createElement('span');
                                        textContent.style.color = 'white';
                                        
                                        listItem.appendChild(bullet);
                                        listItem.appendChild(textContent);
                                        
                                        // Insert after current list item
                                        currentListItem.parentNode.insertBefore(listItem, currentListItem.nextSibling);
                                        
                                        // Move cursor to new list item
                                        const newRange = document.createRange();
                                        newRange.setStart(textContent, 0);
                                        newRange.collapse(true);
                                        selection.removeAllRanges();
                                        selection.addRange(newRange);
                                      }
                                      
                                      // Update content
                                      handleTextareaChange({ target: e.target });
                                    }
                            }
                          }
                        }}
                        className="w-full h-40 p-3 rounded-lg resize-none focus:ring-2 focus:outline-none overflow-y-auto transition-colors duration-300"
                        style={{
                          backgroundColor: themeStyles.secondaryBg, 
                          border: `1px solid ${themeStyles.border}`, 
                          color: themeStyles.textPrimary,
                          '--tw-ring-color': themeStyles.accent,
                          minHeight: '160px'
                        }}
                        data-placeholder="Generated draft will appear here, or write your own response..."
                      />
                      
                      {/* Show HTML preview for debugging */}
                      {draftHtml && (
                        <details className="text-xs">
                          <summary className="cursor-pointer transition-colors duration-300" style={{color: themeStyles.textMuted}}>HTML Preview</summary>
                          <pre className="mt-2 p-2 rounded whitespace-pre-wrap transition-colors duration-300" style={{backgroundColor: themeStyles.tertiaryBg, color: themeStyles.textSecondary}}>
                            {draftHtml}
                          </pre>
                        </details>
                      )}
                    </div>

                    <div className="flex justify-end">
                      <button
                        onClick={sendMessage}
                        disabled={!draftResponse.trim() || isSending}
                        className="px-6 py-2 rounded-lg hover:opacity-80 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2 transition-all duration-300"
                        style={{backgroundColor: themeStyles.success, color: '#FFFFFF'}}
                      >
                        <Send className="w-4 h-4" />
                        {isSending ? 'Sending...' : 'Send Message'}
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center transition-colors duration-300" style={{color: themeStyles.textMuted}}>
            <div className="text-center">
              <Mail className="w-12 h-12 mx-auto mb-4 transition-colors duration-300" style={{color: themeStyles.accent}} />
              <p className="text-lg font-medium transition-colors duration-300" style={{color: themeStyles.textPrimary}}>Select a lead to view details</p>
              <p className="text-sm transition-colors duration-300" style={{color: themeStyles.textSecondary}}>Choose a lead from the inbox to see their conversation history and respond</p>
            </div>
          </div>
        )}
      </div>

      {/* Delete Confirmation Popup */}
      {showDeleteConfirm && leadToDelete && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="rounded-lg p-6 max-w-md w-mx mx-4 shadow-xl" style={{backgroundColor: '#1A1C1A', border: '1px solid white'}}>
            <h3 className="text-lg font-semibold text-white mb-2">Delete Lead</h3>
            <p className="text-gray-300 mb-6">
              Are you sure you want to delete <strong className="text-white">{leadToDelete.first_name} {leadToDelete.last_name}</strong>? 
              This action cannot be undone.
            </p>
            <div className="flex gap-3 justify-end">
              <button
                onClick={() => {
                  setShowDeleteConfirm(false);
                  setLeadToDelete(null);
                }}
                className="px-4 py-2 text-white hover:opacity-80 rounded-lg transition-colors"
                style={{border: '1px solid white'}}
              >
                Cancel
              </button>
              <button
                onClick={() => handleDeleteLead(leadToDelete)}
                className="px-4 py-2 bg-red-600 text-white hover:bg-red-700 rounded-lg transition-colors"
              >
                Delete Lead
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Message Sent Confirmation Popup */}
      {showSentConfirm && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="rounded-lg p-6 max-w-md w-mx mx-4 shadow-xl" style={{backgroundColor: '#1A1C1A', border: '1px solid white'}}>
            <h3 className="text-lg font-semibold text-green-400 mb-2">Message Sent Successfully!</h3>
            <p className="text-gray-300 mb-6">
              Your message has been sent and the conversation has been updated.
            </p>
            <div className="flex gap-3 justify-end">
              <button
                onClick={() => {
                  setShowSentConfirm(false);
                  setSelectedLead(null);
                }}
                className="px-4 py-2 bg-green-600 text-white hover:bg-green-700 rounded-lg transition-colors"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

            {/* Add Enrichment Popup */}
            {showEnrichmentPopup && enrichmentData && (
              <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
                <div className="rounded-lg p-6 max-w-md w-full mx-4 shadow-xl" style={{backgroundColor: '#1A1C1A', border: '1px solid rgba(84, 252, 255, 0.3)'}}>
                  <div className="flex justify-between items-center mb-4">
                    <h3 className="text-lg font-semibold" style={{color: '#54FCFF'}}>Enriched Lead Data</h3>
                    <button
                      onClick={() => setShowEnrichmentPopup(false)}
                      className="text-gray-400 hover:text-white"
                    >
                      <X className="w-5 h-5" />
                    </button>
                  </div>
                  
                  <div className="space-y-4">
                    <div>
                      <label className="text-gray-400 text-sm">Role</label>
                      <p className="text-white font-medium">{enrichmentData.role || 'N/A'}</p>
                    </div>
                    
                    <div>
                      <label className="text-gray-400 text-sm">Company Summary</label>
                      <p className="text-white font-medium">{enrichmentData.companySummary || 'N/A'}</p>
                    </div>
                    
                    <div>
                      <label className="text-gray-400 text-sm">LinkedIn</label>
                      {enrichmentData.linkedin ? (
                        <a
                          href={enrichmentData.linkedin}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="flex items-center gap-2 hover:opacity-80 transition-colors mt-1"
                          style={{color: '#54FCFF'}}
                        >
                          {enrichmentData.linkedin}
                          <ExternalLink className="w-4 h-4" />
                        </a>
                      ) : (
                        <p className="text-white">N/A</p>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
};

export default InboxManager;
