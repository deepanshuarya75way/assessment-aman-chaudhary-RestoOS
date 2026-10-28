import React, { createContext, useContext, useState, useEffect, useRef, useCallback } from 'react';
import i18n from '../locales/i18n';
import { supabase } from '../services/supabase';
import { enqueueOrder, flushQueue, getQueueLenght, setupConnectivityListener } from '../services/offlineSync';

const AppContext = createContext();

const mapOrder = (o) => {
  let extractedContactName = o.contact_name || o.contactName;
  let extractedContactPhone = o.contact_phone || o.contactPhone;
  
  // Extract from dummy item if it exists
  const items = Array.isArray(o.items) ? o.items : [];
  const contactItem = items.find(item => item.id === '__contact_info');
  if (contactItem) {
    if (!extractedContactName) extractedContactName = contactItem.name;
    if (!extractedContactPhone) extractedContactPhone = contactItem.phone;
  }

  return {
    ...o,
    restId: o.rest_id || o.restId,
    orderType: o.order_type || o.orderType,
    verificationCode: o.verification_code || o.verificationCode,
    contactName: extractedContactName,
    contactPhone: extractedContactPhone,
    paymentStatus: o.payment_status || o.paymentStatus,
    paymentMethod: o.payment_method || o.paymentMethod,
    scheduledTime: o.scheduled_time || o.scheduledTime,
    tipAmount: o.tip_amount || o.tipAmount,
    tableNumber: o.table_number || o.tableNumber,
    items: items.filter(item => item.id !== '__contact_info'), // Hide dummy item
  };
};

const mapDish = (d) => ({
  ...d,
  cover: d.macros?.cover || d.cover || '',
  images: d.macros?.images || d.images || [],
  variants: d.macros?.variants || [],
  prepTime: d.macros?.prepTime || d.prepTime,
  serves: d.macros?.serves || d.serves,
  spiceLevel: d.macros?.spiceLevel || d.spiceLevel,
  dietaryPreference: d.macros?.dietaryPreference || d.dietaryPreference,
  customizationCategories: d.macros?.customizationCategories || [],
  modelUrl: d.model_url || d.modelUrl,
  restId: d.rest_id || d.restId
});

// Accurate deep comparison to prevent missed updates in polling
const fastArrayEquals = (prev, next) => {
  if (prev === next) return true;
  if (!prev || !next) return false;
  if (prev.length !== next.length) return false;
  return JSON.stringify(prev) === JSON.stringify(next);
};

// Preload images into browser cache for instant rendering
const preloadImages = (urls) => {
  urls.forEach(url => {
    if (url && typeof url === 'string' && url.startsWith('http')) {
      const img = new Image();
      img.src = url;
    }
  });
};

// Timeout wrapper for fetch calls — never hang forever
const withTimeout = (promise, ms = 8000) => {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('Request timeout')), ms))
  ]);
};

export const useAppContext = () => useContext(AppContext);

export const AppProvider = ({ children }) => {
  const [supabaseUser, setSupabaseUser] = useState(null);
  const [isInitializing, setIsInitializing] = useState(true);
  const [isOnline, setIsOnline] = useState(() => navigator.onLine);
  const [offlineQueueSize, setOfflineQueueSize] = useState(() => getQueueLength());
  const [isDataLoaded, setIsDataLoaded] = useState(() => {
    try {
      const cachedRestaurants = JSON.parse(localStorage.getItem('3dish_cached_restaurants') || '[]');
      const cachedDishes = JSON.parse(localStorage.getItem('3dish_cached_dishes') || '[]');
      return cachedRestaurants.length > 0 && cachedDishes.length > 0;
    } catch {
      return false;
    }
  });

  // Theme State
  const [theme, setTheme] = useState(() => {
    try {
      return localStorage.getItem('3dish_theme') || 'dark'; // Default to dark luxury
    } catch {
      return 'dark';
    }
  });

  useEffect(() => {
    if (theme === 'dark') {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
    localStorage.setItem('3dish_theme', theme);
  }, [theme]);

  const toggleTheme = () => {
    setTheme(prev => prev === 'dark' ? 'light' : 'dark');
  };

  // Core State
  const [user, setUser] = useState(() => {
    try {
      const savedUser = localStorage.getItem('3dish_user');
      if (savedUser) return JSON.parse(savedUser);
      
      const dinerProfile = localStorage.getItem('3dish_diner_profile');
      if (dinerProfile) {
        const parsed = JSON.parse(dinerProfile);
        return { name: parsed.name, phone: parsed.phone, role: 'diner', guestId: parsed.guestId };
      }
      return null;
    } catch {
      return null;
    }
  }); 
  const [activeRestId, setActiveRestIdState] = useState(() => localStorage.getItem('3dish_active_rest') || null);
  const [tableNumber, setTableNumberState] = useState(() => sessionStorage.getItem('3dish_table_number') || null);
  const [activeDishId, setActiveDishId] = useState(null);
  
  // Ref to track current user for use in subscription callbacks (avoids stale closures)
  const userRef = useRef(user);

  const setActiveRestId = (id) => {
    if (id) localStorage.setItem('3dish_active_rest', id);
    else localStorage.removeItem('3dish_active_rest');
    setActiveRestIdState(id);
  };

  const setTableNumber = (num) => {
    if (num) sessionStorage.setItem('3dish_table_number', num);
    else sessionStorage.removeItem('3dish_table_number');
    setTableNumberState(num);
  };
  
  // Persist user state to localStorage
  useEffect(() => {
    if (user) {
      localStorage.setItem('3dish_user', JSON.stringify(user));
    } else {
      localStorage.removeItem('3dish_user');
    }
    userRef.current = user; // Keep ref in sync for subscription callbacks
  }, [user]);
  
  // Data State
  const [restaurants, setRestaurants] = useState(() => {
    try { return JSON.parse(localStorage.getItem('3dish_cached_restaurants') || '[]'); } catch { return []; }
  });
  const [cart, setCart] = useState([]);
  const [orders, setOrders] = useState([]); 
  const [dishes, setDishes] = useState(() => {
    try { return JSON.parse(localStorage.getItem('3dish_cached_dishes') || '[]'); } catch { return []; }
  }); 
  const [serviceAlerts, setServiceAlerts] = useState([]);
  const [notification, setNotification] = useState(null);

  // Real-time clock synchronized to the exact minute boundary
  const [currentTime, setCurrentTime] = useState(() => new Date());
  useEffect(() => {
    let timeoutId;
    const syncClock = () => {
      setCurrentTime(new Date());
      const now = new Date();
      // Calculate milliseconds until the next minute starts
      const msUntilNextMinute = (60 - now.getSeconds()) * 1000 - now.getMilliseconds();
      // Add a 50ms buffer to ensure we've crossed the boundary before updating state again
      timeoutId = setTimeout(syncClock, msUntilNextMinute + 50);
    };
    // Start the recursive precise timer
    syncClock();
    return () => clearTimeout(timeoutId);
  }, []);

  // ── Promos State ──────────────────────────────────────────────────
  const [promos, setPromos] = useState(() => {
    try { return JSON.parse(localStorage.getItem('3dish_promos') || '{}'); } catch { return {}; }
  });

  useEffect(() => {
    if (restaurants.length === 0) return;
    // Map ALL restaurants — explicitly clearing promos when a campaign is stopped
    const newPromos = {};
    restaurants.forEach(r => {
      newPromos[r.id] = r.macros?.promos || { flash: null, happyHour: null };
    });
    setPromos(prev => {
      if (JSON.stringify(prev) !== JSON.stringify(newPromos)) {
        localStorage.setItem('3dish_promos', JSON.stringify(newPromos));
        return newPromos;
      }
      return prev;
    });
  }, [restaurants]);

  const updateMarketingCampaign = async (restId, type, campaignData) => {
    setPromos(prev => {
      const current = prev[restId] || { flash: null, happyHour: null };
      const nextPromoState = { ...current, [type]: campaignData };
      const next = { ...prev, [restId]: nextPromoState };
      localStorage.setItem('3dish_promos', JSON.stringify(next));
      return next;
    });
    
    if (!supabase) return;
    const rest = restaurants.find(r => r.id === restId);
    if (rest) {
      const currentMacros = rest.macros || {};
      const currentPromos = currentMacros.promos || { flash: null, happyHour: null };
      const nextPromos = { ...currentPromos, [type]: campaignData };
      const newMacros = { ...currentMacros, promos: nextPromos };
      
      const { error } = await supabase.from('restaurants').update({ macros: newMacros }).eq('id', restId);
      if (error) {
        console.error('Failed to update marketing campaign in DB:', error);
      }
    }
  };

  const ordersChannelRef = useRef(null);

  // ── Subscription Plan State ────────────────────────────────────────
  // Get plan for a given restaurant directly from the live database macros (defaults to 'Starter' for backward compatibility)
  const planFor = React.useCallback((restId) => {
    const rest = restaurants.find(r => r.id === restId);
    return rest?.macros?.plan || 'Starter';
  }, [restaurants]);

  // Backward compatibility object so context doesn't break
  const plans = {};

  // Request a plan upgrade — sets pendingPlan for admin approval instead of upgrading directly
  const upgradePlan = async (restId, newPlan) => {
    const rest = restaurants.find(r => r.id === restId);
    if (!rest) return;
    const currentMacros = rest.macros || {};
    const newMacros = { ...currentMacros, pendingPlan: newPlan };
    
    // Optimistic UI update (only pendingPlan changes, actual plan stays the same)
    setRestaurants(prev => prev.map(r => r.id === restId ? { ...r, macros: newMacros } : r));
    
    try {
      const { error } = await supabase.from('restaurants').update({ macros: newMacros }).eq('id', restId);
      if (error) throw error;
    } catch (err) {
      console.error("Failed to request plan upgrade", err);
    }
  };
  const [favorites, setFavorites] = useState(() => {
    try { return JSON.parse(localStorage.getItem('3dish_favorites') || '[]'); } catch { return []; }
  });
  const [nutritionHistory, setNutritionHistory] = useState(() => {
    try { return JSON.parse(localStorage.getItem('3dish_nutrition_history') || '[]'); } catch { return []; }
  });
  const [userPreferences, setUserPreferences] = useState(() => {
    try { 
      return JSON.parse(localStorage.getItem('3dish_preferences')) || {
        language: 'en',
        goals: { calories: 2000, protein: 150, carbs: 250, fat: 65 }
      };
    } catch { 
      return { language: 'en', goals: { calories: 2000, protein: 150, carbs: 250, fat: 65 } }; 
    }
  });

  const updatePreferences = (newPrefs) => {
    setUserPreferences(prev => {
      const updated = { ...prev, ...newPrefs };
      localStorage.setItem('3dish_preferences', JSON.stringify(updated));
      return updated;
    });
  };

  useEffect(() => {
    const handleOnline = () => {setIsOnline(true);};
    const handleOffline = () => setIsOnline(false);
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    return () => {
      window.addEventListener('online', handleOnline);
      window.addEventListener('offline', handleOffline);
    };
  }, []);

  useEffect(() => {
    if(!supabase || !isOnline) return;
    flushQueue(supabase, {
      onSuccess: (_op, reason) => {
        setOfflineQueueSize(getQueueLenght());
        if(reason === 'synced') showNotification('Offline order synced successfully');
      },
      onPermanentFailure: (_op) => {
        setOfflineQueueSize(getQueueLenght());
        showNotification('An offline order could not be synced. Please re-order');
      },
    });
  }, [isOnline, supabaseUser]);

  // 1. Auth Init
  useEffect(() => {
    if (!supabase) { 
      setIsInitializing(false); 
      return; 
    }

    // Use onAuthStateChange as the single source of truth for auth state.
    // With detectSessionInUrl + PKCE enabled, this fires an INITIAL_SESSION event
    // AFTER processing any OAuth code/token in the URL — so we never have a
    // race condition where we redirect before the email link auth completes.
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      const u = session?.user || null;
      setSupabaseUser(u);
      if (u) {
        setUser(prev => {
          if (prev?.role === 'diner') {
            return { ...prev, email: u.email, uid: u.id };
          }
          return { ...prev, email: u.email, uid: u.id, role: 'vendor' };
        });
      } else {
        setUser(prev => (prev?.role === 'vendor' ? null : prev));
      }

      // Mark initialization as complete after the first auth event fires
      // (covers both INITIAL_SESSION from existing session and SIGNED_IN from email links)
      if (event === 'INITIAL_SESSION' || event === 'SIGNED_IN' || event === 'SIGNED_OUT' || event === 'TOKEN_REFRESHED') {
        setIsInitializing(false);
      }
    });

    // Fallback: if onAuthStateChange never fires within 5s, unblock the UI anyway
    const fallbackTimer = setTimeout(() => setIsInitializing(false), 5000);

    return () => {
      subscription.unsubscribe();
      clearTimeout(fallbackTimer);
    };
  }, []);

  // Sync language on mount
  useEffect(() => {
    if (userPreferences?.language) {
      i18n.changeLanguage(userPreferences.language);
    }
  }, [userPreferences.language]);

  const showNotification = React.useCallback((msg) => {
    setNotification(msg);
    setTimeout(() => setNotification(null), 3500);
  }, []);

  // 2. Real-time Sync — Robust data loading with timeout + error handling
  useEffect(() => {
    if (!supabase) {
      setIsDataLoaded(true); // Don't block UI if supabase is unavailable
      return;
    }
    
    let realtimeConnected = false;

    const fetchOrders = async () => {
      try {
        const { data, error } = await withTimeout(
          supabase.from('orders').select('*').order('timestamp', { ascending: false })
        );
        if (error) { console.warn('Orders fetch error:', error.message); return; }
        if (data) {
          const mappedOrders = data.map(mapOrder);
          setOrders(prev => fastArrayEquals(prev, mappedOrders) ? prev : mappedOrders);
        }
      } catch (err) {
        console.warn('Orders fetch timeout/error:', err.message);
      }
    };
    
    const fetchDishes = async () => {
      try {
        const { data, error } = await withTimeout(
          supabase.from('dishes').select('*')
        );
        if (error) { console.warn('Dishes fetch error:', error.message); return; }
        if (data) {
          const mapped = data.map(mapDish);
          setDishes(prev => {
            if (fastArrayEquals(prev, mapped)) return prev;
            // Cache to localStorage for instant next load
            try { localStorage.setItem('3dish_cached_dishes', JSON.stringify(mapped)); } catch {}
            return mapped;
          });
          // Preload first 10 dish images into browser cache
          const imageUrls = mapped.slice(0, 10).map(d => d.cover || d.images?.[0]).filter(Boolean);
          preloadImages(imageUrls);
        }
      } catch (err) {
        console.warn('Dishes fetch timeout/error:', err.message);
      }
    };

    const fetchRestaurants = async () => {
      try {
        const { data, error } = await withTimeout(
          supabase.from('restaurants').select('*')
        );
        if (error) { console.warn('Restaurants fetch error:', error.message); return; }
        if (data) {
          setRestaurants(prev => {
            const mapped = data.map(r => ({
              ...r,
              vendorId: r.vendor_id || r.vendorId,
              cover: r.cover || '',
              requireVerificationCode: r.macros?.requireVerificationCode !== undefined ? r.macros.requireVerificationCode : false
            }));
            if (fastArrayEquals(prev, mapped)) return prev;
            try {
              localStorage.setItem('3dish_cached_restaurants', JSON.stringify(mapped));
            } catch {}
            return mapped;
          });
        }
      } catch (err) {
        console.warn('Restaurants fetch timeout/error:', err.message);
      }
    };

    // Load data with guaranteed isDataLoaded=true (even on failure, show cached or empty)
    const loadAllData = async () => {
      try {
        await Promise.allSettled([fetchDishes(), fetchRestaurants()]);
      } catch {}
      setIsDataLoaded(true); // ALWAYS unblock the UI
      // Orders load in background, don't block UI
      fetchOrders();
    };
    loadAllData();

    // Real-time subscriptions
    const ordersSub = supabase.channel('custom-orders')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'orders' }, (payload) => {
        realtimeConnected = true;
        if (payload.eventType === 'INSERT') {
          const mapped = mapOrder(payload.new);
          setOrders(prev => {
            if (prev.some(o => o.id === mapped.id)) return prev;
            return [mapped, ...prev];
          });
        } else if (payload.eventType === 'UPDATE') {
          const mapped = mapOrder(payload.new);
          setOrders(prev => prev.map(o => o.id === mapped.id ? mapped : o));
        } else if (payload.eventType === 'DELETE') {
          setOrders(prev => prev.filter(o => o.id !== payload.old.id));
        }
      }).subscribe((status) => { if (status === 'SUBSCRIBED') realtimeConnected = true; });
      
    const dishesSub = supabase.channel('custom-dishes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'dishes' }, (payload) => {
        realtimeConnected = true;
        if (payload.eventType === 'INSERT') {
          const mapped = mapDish(payload.new);
          setDishes(prev => {
            if (prev.some(d => d.id === mapped.id)) return prev;
            return [...prev, mapped];
          });
          // Preload new dish image
          if (mapped.cover) preloadImages([mapped.cover]);
        } else if (payload.eventType === 'UPDATE') {
          const mapped = mapDish(payload.new);
          setDishes(prev => prev.map(d => d.id === mapped.id ? mapped : d));
          if (mapped.cover) preloadImages([mapped.cover]);
        } else if (payload.eventType === 'DELETE') {
          setDishes(prev => prev.filter(d => d.id !== payload.old.id));
        }
      }).subscribe();

    const restSub = supabase.channel('custom-restaurants')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'restaurants' }, (payload) => {
        realtimeConnected = true;
        if (payload.eventType === 'INSERT' || payload.eventType === 'UPDATE') {
          const r = payload.new;
          const mapped = {
            ...r,
            vendorId: r.vendor_id || r.vendorId,
            cover: r.cover || '',
            requireVerificationCode: r.macros?.requireVerificationCode !== undefined ? r.macros.requireVerificationCode : false
          };
          setRestaurants(prev => {
            const exists = prev.some(item => item.id === mapped.id);
            const next = exists
              ? prev.map(item => item.id === mapped.id ? { ...item, ...mapped } : item)
              : [...prev, mapped];
            return next;
          });
        } else if (payload.eventType === 'DELETE') {
          setRestaurants(prev => prev.filter(r => r.id !== payload.old.id));
        }
      }).subscribe();
    
    // Smart polling: 30s fallback, only runs when page visible AND realtime is disconnected
    const pollInterval = setInterval(() => {
      if (document.hidden) return;
      // Always do a light refresh, but less frequently than before
      fetchOrders();
      // Only re-fetch dishes/restaurants if realtime seems disconnected
      if (!realtimeConnected) {
        fetchDishes();
        fetchRestaurants();
      }
    }, 30000);

    // Immediate re-fetch when user comes back to the tab (instant freshness)
    const handleVisibilityChange = () => {
      if (!document.hidden) {
        fetchOrders();
        fetchDishes();
        fetchRestaurants();
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);

    // Broadcast channel for real-time order status updates (Vendor -> Customer)
    const ordersChannel = supabase.channel('orders-realtime', {
      config: { broadcast: { ack: false } }
    });

    ordersChannel
      .on('broadcast', { event: 'status-update' }, (payload) => {
        if (payload?.payload?.orderId && payload?.payload?.newStatus) {
          const { orderId, newStatus, cancelReason } = payload.payload;
          setOrders(prev => prev.map(o => o.id === orderId ? {
            ...o,
            status: newStatus,
            ...(cancelReason ? { metadata: { ...(o.metadata || {}), cancelReason } } : {}),
          } : o));
        }
      }).subscribe();
    
    ordersChannelRef.current = ordersChannel;

    // Broadcast channel for real-time service requests (Customer -> Vendor)
    const serviceChannel = supabase.channel('service-requests')
      .on('broadcast', { event: 'waiter_call' }, (payload) => {
        if (payload.payload) {
          setServiceAlerts(prev => [payload.payload, ...prev]);
          if (userRef.current?.role === 'vendor') {
            showNotification(`Table ${payload.payload.tableNumber} requested: ${payload.payload.type}`);
          }
        }
      }).subscribe();

    return () => { 
      supabase.removeChannel(ordersSub);
      supabase.removeChannel(dishesSub);
      supabase.removeChannel(restSub);
      supabase.removeChannel(serviceChannel);
      if (ordersChannelRef.current) {
        supabase.removeChannel(ordersChannelRef.current);
      }
      clearInterval(pollInterval);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [supabaseUser]);

  // Auto-set activeRestId for logged-in vendor on mount or when restaurants list updates
  useEffect(() => {
    if (!supabaseUser || restaurants.length === 0) return;
    
    // If we have a stored activeRestId, verify it still belongs to this vendor
    if (activeRestId) {
      const stillValid = restaurants.some(
        r => r.id === activeRestId && (r.vendorId === supabaseUser.id || r.vendor_id === supabaseUser.id)
      );
      if (stillValid) return; // Already pointing to a valid restaurant
    }
    
    // Find the most recently created restaurant for this vendor
    const myRests = restaurants
      .filter(r => r.vendorId === supabaseUser.id || r.vendor_id === supabaseUser.id)
      .sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
    
    if (myRests.length > 0) {
      setActiveRestId(myRests[0].id);
    }
  }, [restaurants, supabaseUser, activeRestId]);

  // Resilient Continuous Looping Audio Notification for Pending/Awaiting Verification Orders
  const notificationAudioRef = useRef(null);
  useEffect(() => {
    if (!supabaseUser || user?.role !== 'vendor') {
      if (notificationAudioRef.current) {
        notificationAudioRef.current.pause();
        notificationAudioRef.current = null;
      }
      return;
    }

    const hasPendingOrders = orders.some(o => {
      const isMyRest = o.restId === activeRestId || o.rest_id === activeRestId;
      if (!isMyRest) return false;

      const type = o.orderType || o.order_type;
      if (type === 'delivery') {
        return o.status === 'Pending';
      } else {
        return o.status === 'Pending Verification';
      }
    });

    if (hasPendingOrders) {
      if (!notificationAudioRef.current) {
        const audio = new Audio('https://assets.mixkit.co/active_storage/sfx/2869/2869-preview.mp3');
        audio.loop = true;
        notificationAudioRef.current = audio;
        audio.play().catch(e => {
          console.log("Audio play blocked by browser. User interaction needed:", e);
          const playOnGesture = () => {
            audio.play().catch(err => console.log("Audio retry failed:", err));
            document.removeEventListener('click', playOnGesture);
          };
          document.addEventListener('click', playOnGesture);
        });
      } else {
        notificationAudioRef.current.play().catch(e => {});
      }
    } else {
      if (notificationAudioRef.current) {
        notificationAudioRef.current.pause();
        notificationAudioRef.current = null;
      }
    }

    return () => {
      if (notificationAudioRef.current) {
        notificationAudioRef.current.pause();
      }
    };
  }, [orders, activeRestId, user, supabaseUser]);

  const addToCart = (dish) => {
    // Stamp the effective price at add-time so every consumer (subtotal, placeOrder, etc.) reads it correctly
    let effectivePrice = dish.selectedVariant ? Number(dish.selectedVariant.price) : Number(dish.price);
    
    // Add customizations price
    if (dish.selectedCustomizations && dish.selectedCustomizations.length > 0) {
      effectivePrice += dish.selectedCustomizations.reduce((sum, cust) => sum + (Number(cust.price) || 0), 0);
    }
    
    const customizationId = dish.selectedCustomizations ? JSON.stringify(dish.selectedCustomizations.map(c => c.id).sort()) : null;

    setCart(prev => [...prev, { ...dish, price: effectivePrice, customizationId, cartId: Date.now() }]);
    showNotification('Added to cart');
  };

  const removeOneFromCart = (dishId, variantName, customizationId) => {
    setCart(prev => {
      const idx = prev.findLastIndex(item => 
        item.id === dishId && 
        (!variantName || (item.selectedVariant?.name === variantName || item.variantName === variantName)) &&
        (customizationId === undefined || item.customizationId === customizationId)
      );
      if (idx === -1) return prev;
      return prev.filter((_, i) => i !== idx);
    });
  };

  const toggleFavorite = (dishId) => {
    setFavorites(prev => {
      const next = prev.includes(dishId) ? prev.filter(id => id !== dishId) : [...prev, dishId];
      localStorage.setItem('3dish_favorites', JSON.stringify(next));
      return next;
    });
  };

  const saveNutritionRecord = (items, restName) => {
    const macros = items.reduce((acc, item) => {
      if (item.macros) {
        acc.calories += parseInt(item.macros.calories) || 0;
        acc.protein  += parseInt(item.macros.protein)  || 0;
        acc.carbs    += parseInt(item.macros.carbs)    || 0;
        acc.fat      += parseInt(item.macros.fat)      || 0;
      }
      return acc;
    }, { calories: 0, protein: 0, carbs: 0, fat: 0 });

    const record = {
      date: new Date().toISOString(),
      restName,
      items: items.map(i => i.name),
      macros,
    };
    setNutritionHistory(prev => {
      const next = [record, ...prev].slice(0, 30);
      localStorage.setItem('3dish_nutrition_history', JSON.stringify(next));
      return next;
    });
  };

  const placeOrder = async (orderData) => {
    if (!supabase) {
      showNotification('Cloud connection required.');
      return false;
    }

    const idempotencyKey = orderData.idempotencyKey || `${Date.now()}-${Math.random().toString(36).slice(2)}`;

    const rest = restaurants.find(r => r.id === activeRestId);
    const taxRate = rest?.tax_rate !== undefined ? rest.tax_rate / 100 : 0.08;

    // Additional delivery fees
    const deliveryConfig = rest?.macros?.deliveryConfig || {};
    const convenienceFee = orderData?.orderType === 'delivery' ? (Number(deliveryConfig.convenienceFee) || 0) : 0;
    const otherFees = orderData?.orderType === 'delivery' ? (deliveryConfig.otherFees || []) : [];
    const otherFeesTotal = otherFees.reduce((sum, f) => sum + (Number(f.amount) || 0), 0);
    const baseDeliveryFee = orderData?.orderType === 'delivery' ? (Number(deliveryConfig.deliveryFee) || 0) : 0;

    const dinerProfile = JSON.parse(localStorage.getItem('3dish_diner_profile') || '{}');
    const guestId = user?.uid || user?.id || user?.guestId || dinerProfile.guestId || user?.phone || dinerProfile.phone || 'anonymous';

        // Check if free dish offer is met (supporting single and multi-offers)
    const rawOffers = rest?.macros?.offers;
    const allOffers = Array.isArray(rawOffers)
      ? rawOffers
      : (rawOffers && rawOffers.freeDishId ? [rawOffers] : []);
    
    const regularSubtotal = cart.reduce((sum, item) => sum + Number(item.price || 0), 0);
    
    const activeOffers = allOffers.filter(
      o => o.active && Number(o.minOrderValue) > 0 && o.freeDishId
    );
    
    // Pick qualifying offer with the highest minOrderValue
    const qualifyingOffers = activeOffers.filter(o => regularSubtotal >= Number(o.minOrderValue));
    const matchedOffer = qualifyingOffers.length > 0
      ? qualifyingOffers.reduce((best, o) => Number(o.minOrderValue) > Number(best.minOrderValue) ? o : best, qualifyingOffers[0])
      : null;
    
    let orderItems = [...cart];
    if (matchedOffer) {
      const [dishId, variantName] = matchedOffer.freeDishId.split('::');
      const d = dishes.find(x => x.id === dishId);
      if (d) {
        let name = d.name;
        let selectedVariant = null;
        if (d.variants && d.variants.length > 0) {
          const v = variantName ? d.variants.find(varItem => varItem.name === variantName) : d.variants[0];
          if (v) {
            name = `${d.name} (${v.name})`;
            selectedVariant = v;
          }
        }
        orderItems.push({
          id: d.id,
          name: `${name} [FREE]`,
          price: 0,
          quantity: 1,
          isFree: true,
          cover: d.cover || d.images?.[0],
          selectedVariant: selectedVariant,
          type: 'free_dish'
        });
      }
    }

    const newOrder = {
      user_id: guestId,
      rest_id: activeRestId,
      items: [
        ...orderItems,
        ...(orderData?.specialInstructions ? [{ id: '__special_instructions', instructions: orderData.specialInstructions, price: 0, quantity: 0, type: 'metadata' }] : [])
      ],
      total: (cart.reduce((sum, item) => sum + Number(item.price || 0), 0) * (1 + taxRate)) + convenienceFee + baseDeliveryFee + otherFeesTotal,
      status: orderData?.status || 'Pending',
      timestamp: new Date().toISOString(),
      table_number: orderData?.tableNumber !== undefined ? (parseInt(orderData.tableNumber) || null) : (tableNumber === 'delivery' ? null : (parseInt(tableNumber) || null)),
    };

    const contactName = orderData?.contactName || user?.name || dinerProfile?.name || '';
    const contactPhone = orderData?.contactPhone || user?.phone || dinerProfile?.phone || '';

    // Merge extra fields from checkout flow (snake_case for Supabase)
    if (orderData?.orderType)         newOrder.order_type        = orderData.orderType;
    if (orderData?.paymentMethod)     newOrder.payment_method    = orderData.paymentMethod;
    if (orderData?.paymentStatus)     newOrder.payment_status    = orderData.paymentStatus;
    
    if (orderData?.verificationCode !== undefined) {
      newOrder.verification_code = orderData.verificationCode;
    }

    if (contactName)                  newOrder.contact_name      = contactName;
    if (contactPhone)                 newOrder.contact_phone     = contactPhone;
    if (orderData?.scheduledTime)     newOrder.scheduled_time    = orderData.scheduledTime;
    if (orderData?.tipAmount != null) newOrder.tip_amount        = orderData.tipAmount;
    const finalMetadata = {
      ...(orderData.specialInstructions ? { specialInstructions: orderData.specialInstructions } : {}),
      ...(orderData.metadata || {}),
      ...(orderData?.orderType === 'delivery' ? {
        deliveryFee: baseDeliveryFee,
        convenienceFee: convenienceFee,
        otherFees: otherFees
      } : {})
    };
    if (Object.keys(finalMetadata).length > 0) {
      newOrder.metadata = finalMetadata;
    }

    // Always encode location into items as a resilient fallback (survives metadata column being absent).
    // This covers both GPS-detected locations AND manually typed addresses.
    if (orderData?.metadata?.location || orderData?.metadata?.address) {
      const coords = orderData.metadata.location || {};
      newOrder.items = [
        ...newOrder.items,
        {
          id: '__location',
          lat: coords.lat ?? null,
          lng: coords.lng ?? null,
          address: orderData.metadata.address || '',
          price: 0,
          quantity: 0,
          type: 'location_meta'
        }
      ];
    }

    newOrder.metaData = {...AppContext(newOrder.metaData || {}), idempotencyKey};

    if(!navigator.online) {
      enqueueOrder(idempotencyKey, newOrder);
      setOfflineQueueSize(getQueueLenght());
      setCart([]);
      const restName = restaurants.find(r => r.id === activeRestId)?.name || 'Restaurant';
      saveNutritionRecord(cart, restName);
      showNotification('Your are offline. Order save - it will sync when you reconnect');
      return true;
    }

    try {
      const { error } = await supabase.from('orders').insert([newOrder]);
      if (error) {
        // If insert fails because extra columns don't exist in DB (e.g. metadata), retry without it
        if (error.message && (error.message.includes('column') || error.code === '42703')) {
          console.warn('Full insert failed, retrying without metadata:', error.message);
          const { metadata, ...orderWithoutMetadata } = newOrder;
          
          const { error: retryError } = await supabase.from('orders').insert([orderWithoutMetadata]);
          if (retryError) {
            console.warn('Retry without metadata failed, falling back to core fields only:', retryError.message);
            const coreOrder = {
              user_id: newOrder.user_id,
              rest_id: newOrder.rest_id,
              items: newOrder.items,
              total: newOrder.total,
              status: newOrder.status,
              timestamp: newOrder.timestamp,
            };
            if (newOrder.contact_name) coreOrder.contact_name = newOrder.contact_name;
            if (newOrder.contact_phone) coreOrder.contact_phone = newOrder.contact_phone;
            
            const { error: coreError } = await supabase.from('orders').insert([coreOrder]);
            if (coreError) {
              if (coreError.message && (coreError.message.includes('column') || coreError.code === '42703')) {
                // Remove contact_name/phone and stuff them into items as a dummy item
                delete coreOrder.contact_name;
                delete coreOrder.contact_phone;
                coreOrder.items = [...coreOrder.items, { id: '__contact_info', name: newOrder.contact_name, phone: newOrder.contact_phone, price: 0, quantity: 0, type: 'metadata' }];
                const { error: finalError } = await supabase.from('orders').insert([coreOrder]);
                if (finalError) throw finalError;
              } else {
                throw coreError;
              }
            }
          }
        } else {
          throw error;
        }
      }
      
      setCart([]);
      const restName = restaurants.find(r => r.id === activeRestId)?.name || 'Restaurant';
      saveNutritionRecord(cart, restName);
      showNotification('Order placed successfully!');
      return true;
    } catch (error) { 
      console.error('Place order error:', error);
      showNotification(`Failed to place order: ${error.message || 'Unknown error'}`);
      return false;
    }
  };

  const addRestaurant = async (restData) => {
    if (!supabaseUser) return { error: 'Not authenticated' };
    
    // Check if the user already has a restaurant
    const hasRestaurant = restaurants.some(
      r => r.vendorId === supabaseUser.id || r.vendor_id === supabaseUser.id
    );
    
    if (hasRestaurant) {
      showNotification('You can only create one restaurant per account.');
      return { error: 'One restaurant per account limit reached.' };
    }
    
    const newRest = {
      vendor_id: supabaseUser.id,
      name: restData.name,
      cover: restData.cover,
      macros: { status: 'pending', plan: 'Starter', vendorEmail: supabaseUser.email }
    };

    try {
      const { data, error } = await supabase.from('restaurants').insert([newRest]).select();
      if (error) throw error;
      // Immediately update local state so dashboard renders without full reload
      const mapped = {
        ...data[0],
        vendorId: data[0].vendor_id,
        cover: data[0].cover || '',
        requireVerificationCode: false,
      };
      setRestaurants(prev => [...prev, mapped]);
      return { id: data[0].id };
    } catch (error) {
      console.error('Create restaurant error:', error);
      showNotification(`Failed to create restaurant: ${error.message || error.details || 'Unknown error'}`);
      return { error: error.message || error.details || 'Unknown error' };
    }
  };

  const updateRestaurant = async (restId, updateData, silent = false) => {
    if (!supabaseUser) {
      if (!silent) showNotification('You must be logged in to update settings.');
      return;
    }
    if (!restId) {
      if (!silent) showNotification('No restaurant selected. Please complete onboarding first.');
      return;
    }

    // ── Step 1: Update local state FIRST (UI responds instantly, no error shown) ──
    setRestaurants(prev => {
      const next = prev.map(r => r.id === restId ? {
        ...r,
        name:        updateData.name        !== undefined ? updateData.name        : r.name,
        cover:       updateData.cover       !== undefined ? updateData.cover       : r.cover,
        taxRate:     updateData.taxRate     !== undefined ? updateData.taxRate     : r.taxRate,
        tax_rate:    updateData.taxRate     !== undefined ? updateData.taxRate     : r.tax_rate,
        acceptCash:  updateData.acceptCash  !== undefined ? updateData.acceptCash  : r.acceptCash,
        accept_cash: updateData.acceptCash  !== undefined ? updateData.acceptCash  : r.accept_cash,
        hours:       updateData.hours       !== undefined ? updateData.hours       : r.hours,
        requireVerificationCode: updateData.requireVerificationCode !== undefined
          ? updateData.requireVerificationCode
          : r.requireVerificationCode,
        macros: (updateData.deliveryConfig !== undefined || updateData.requireVerificationCode !== undefined || updateData.phone !== undefined || updateData.phoneVerified !== undefined || updateData.socials !== undefined || updateData.customizations !== undefined || updateData.offers !== undefined || updateData.logo !== undefined || updateData.vendorEmail !== undefined || updateData.hours !== undefined)
          ? {
              ...(r.macros || {}),
              ...(updateData.deliveryConfig          !== undefined ? { deliveryConfig: updateData.deliveryConfig } : {}),
              ...(updateData.requireVerificationCode !== undefined ? { requireVerificationCode: updateData.requireVerificationCode } : {}),
              ...(updateData.phone                  !== undefined ? { phone: updateData.phone } : {}),
              ...(updateData.phoneVerified           !== undefined ? { phoneVerified: updateData.phoneVerified } : {}),
              ...(updateData.socials                 !== undefined ? { socials: updateData.socials } : {}),
              ...(updateData.customizations          !== undefined ? { customizations: updateData.customizations } : {}),
              ...(updateData.offers                  !== undefined ? { offers: updateData.offers } : {}),
              ...(updateData.logo                   !== undefined ? { logo: updateData.logo } : {}),
              ...(updateData.vendorEmail            !== undefined ? { vendorEmail: updateData.vendorEmail } : {}),
              ...(updateData.hours                  !== undefined ? { hours: updateData.hours } : {}),
            }
          : r.macros,
      } : r);
      // Also persist to localStorage so value survives page refresh
      try { localStorage.setItem('3dish_cached_restaurants', JSON.stringify(next)); } catch {}
      return next;
    });

    try {
      // ── Step 2: Push known scalar columns (name, cover, tax_rate, accept_cash) ──
      // These columns are guaranteed to exist in the DB schema.
      const scalarPayload = {};
      if (updateData.name       !== undefined) scalarPayload.name        = updateData.name;
      if (updateData.cover      !== undefined) scalarPayload.cover       = updateData.cover;
      if (updateData.taxRate    !== undefined) scalarPayload.tax_rate    = updateData.taxRate;
      if (updateData.acceptCash !== undefined) scalarPayload.accept_cash = updateData.acceptCash;

      if (Object.keys(scalarPayload).length > 0) {
        const { error } = await supabase.from('restaurants').update(scalarPayload).eq('id', restId);
        if (error) throw error;
      }

      // ── Step 3: Try to save macros blob (column may not exist — silently skip) ──
      // requireVerificationCode and deliveryConfig live here. If the column is missing,
      // the value is already saved in local state + localStorage above, so the toggle
      // still works correctly for the session and across page reloads.
      if (updateData.deliveryConfig !== undefined || updateData.requireVerificationCode !== undefined || updateData.phone !== undefined || updateData.phoneVerified !== undefined || updateData.socials !== undefined || updateData.customizations !== undefined || updateData.offers !== undefined || updateData.logo !== undefined || updateData.vendorEmail !== undefined || updateData.hours !== undefined) {
        const currentMacros = restaurants.find(r => r.id === restId)?.macros || {};
        const newMacros = { ...currentMacros };
        if (updateData.deliveryConfig          !== undefined) newMacros.deliveryConfig          = updateData.deliveryConfig;
        if (updateData.requireVerificationCode !== undefined) newMacros.requireVerificationCode = updateData.requireVerificationCode;
        if (updateData.phone                  !== undefined) newMacros.phone                  = updateData.phone;
        if (updateData.phoneVerified           !== undefined) newMacros.phoneVerified           = updateData.phoneVerified;
        if (updateData.socials                 !== undefined) newMacros.socials                 = updateData.socials;
        if (updateData.customizations          !== undefined) newMacros.customizations          = updateData.customizations;
        if (updateData.offers                  !== undefined) newMacros.offers                  = updateData.offers;
        if (updateData.logo                   !== undefined) newMacros.logo                   = updateData.logo;
        if (updateData.vendorEmail            !== undefined) newMacros.vendorEmail            = updateData.vendorEmail;
        if (updateData.hours                  !== undefined) newMacros.hours                  = updateData.hours;

        const { error: macrosError } = await supabase.from('restaurants')
          .update({ macros: newMacros })
          .eq('id', restId);
        if (macrosError) {
          // Silently swallow — macros column may not exist in this DB deployment.
          // The value is already persisted locally; no error shown to vendor.
          console.warn('[3Dish] macros column unavailable — toggle saved locally only:', macrosError.message);
        }
      }

      if (!silent) showNotification('Settings updated successfully!');
    } catch (error) {
      console.error('Update restaurant error:', error);
      if (!silent) showNotification(`Failed to update settings: ${error.message}`);
    }
  };

  const addDish = async (dishData) => {
    if (!supabaseUser) {
      showNotification('You must be logged in to add a dish.');
      return null;
    }
    if (!dishData.restId) {
      showNotification('No restaurant selected. Please complete onboarding first.');
      return null;
    }
    try {
      const formattedDish = { 
        name: dishData.name,
        price: parseFloat(dishData.price) || (dishData.variants?.length > 0 ? parseFloat(dishData.variants[0].price) : 0),
        description: dishData.description || '',
        model_url: dishData.modelUrl || '',
        macros: { 
          ...(dishData.macros || {}), 
          cover: dishData.cover || '', 
          images: dishData.images || [], 
          variants: dishData.variants || [],
          prepTime: dishData.prepTime,
          serves: dishData.serves,
          spiceLevel: dishData.spiceLevel,
          dietaryPreference: dishData.dietaryPreference,
          customizationCategories: dishData.customizationCategories || [],
        },
        tags: dishData.tags || [],
        allergens: dishData.allergens || [],
        ingredients: dishData.ingredients || [],
        rest_id: dishData.restId
      };
      
      console.log('Inserting dish:', formattedDish);
      const { data, error } = await supabase.from('dishes').insert([formattedDish]).select();
      if (error) throw error;
      
      setDishes(prev => [...prev, mapDish(data[0])]);
      showNotification('Dish saved successfully!');
      return data[0].id;
    } catch (error) {
      console.error('Save dish error:', error);
      showNotification(`Failed to save dish: ${error.message || error.details || 'Unknown error'}`);
      return null;
    }
  };

  const updateDish = async (dishId, updates) => {
    if (!supabaseUser) {
      showNotification('You must be logged in to update a dish.');
      return;
    }
    try {
      const dbUpdate = {};
      if (updates.name !== undefined) dbUpdate.name = updates.name;
      if (updates.price !== undefined) {
        dbUpdate.price = parseFloat(updates.price) || 0;
      }
      // Sync base price with the first variant if variants are updated/created
      if (updates.variants !== undefined) {
        dbUpdate.price = updates.variants.length > 0 ? parseFloat(updates.variants[0].price) || 0 : (parseFloat(updates.price || currentDish?.price) || 0);
      }
      if (updates.description !== undefined) dbUpdate.description = updates.description;
      if (updates.model_url !== undefined) dbUpdate.model_url = updates.model_url;
      if (updates.modelUrl !== undefined) dbUpdate.model_url = updates.modelUrl;
      
      // Handle macros JSONB column for custom data (like cover, images, extra UI fields)
      const currentDish = dishes.find(d => d.id === dishId);
      dbUpdate.macros = { ...(currentDish?.macros || {}) };
      if (updates.macros !== undefined) dbUpdate.macros = { ...dbUpdate.macros, ...updates.macros };
      if (updates.cover !== undefined) dbUpdate.macros.cover = updates.cover;
      if (updates.images !== undefined) dbUpdate.macros.images = updates.images;
      if (updates.variants !== undefined) dbUpdate.macros.variants = updates.variants;
      if (updates.prepTime !== undefined) dbUpdate.macros.prepTime = updates.prepTime;
      if (updates.serves !== undefined) dbUpdate.macros.serves = updates.serves;
      if (updates.spiceLevel !== undefined) dbUpdate.macros.spiceLevel = updates.spiceLevel;
      if (updates.dietaryPreference !== undefined) dbUpdate.macros.dietaryPreference = updates.dietaryPreference;
      if (updates.customizationCategories !== undefined) dbUpdate.macros.customizationCategories = updates.customizationCategories;
      
      if (updates.tags !== undefined) dbUpdate.tags = updates.tags;
      if (updates.allergens !== undefined) dbUpdate.allergens = updates.allergens;
      if (updates.ingredients !== undefined) dbUpdate.ingredients = updates.ingredients;
      if (updates.restId !== undefined) dbUpdate.rest_id = updates.restId;
      if (updates.rest_id !== undefined) dbUpdate.rest_id = updates.rest_id;

      console.log('Updating dish:', dishId, dbUpdate);
      const { data, error } = await supabase.from('dishes').update(dbUpdate).eq('id', dishId).select();
      if (error) throw error;
      
      if (data && data[0]) {
        const mappedDish = mapDish(data[0]);
        setDishes(prev => prev.map(d => d.id === dishId ? mappedDish : d));
      }
      showNotification('Dish updated successfully.');
      return true;
    } catch (error) {
      console.error('Update dish error:', error);
      showNotification(`Failed to update dish: ${error.message}`);
      return null;
    }
  };

  const deleteDish = async (dishId) => {
    if (!supabaseUser) {
      showNotification('You must be logged in to delete a dish.');
      return false;
    }
    try {
      const { error } = await supabase.from('dishes').delete().eq('id', dishId);
      if (error) throw error;
      setDishes(prev => prev.filter(d => d.id !== dishId));
      showNotification('Dish deleted successfully.');
      return true;
    } catch (error) {
      console.error('Delete dish error:', error);
      showNotification(`Failed to delete dish: ${error.message}`);
      return false;
    }
  };

  const rsvpToEvent = async (eventId, updatedMacros) => {
    try {
      const dbUpdate = { macros: updatedMacros };
      
      console.log('RSVPing to event:', eventId, dbUpdate);
      const { data, error } = await supabase.from('dishes').update(dbUpdate).eq('id', eventId).select();
      if (error) throw error;
      
      if (data && data[0]) {
        const mappedDish = {
          ...data[0],
          cover: data[0].macros?.cover || '',
          images: data[0].macros?.images || [],
          modelUrl: data[0].model_url || data[0].modelUrl,
          restId: data[0].rest_id || data[0].restId
        };
        setDishes(prev => prev.map(d => d.id === eventId ? mappedDish : d));
      }
      return true;
    } catch (error) {
      console.error('RSVP event error:', error);
      showNotification(`Failed to RSVP: ${error.message}`);
      return false;
    }
  };

  const updateOrderStatus = async (orderId, newStatus, cancelReason) => {
    if (!supabase) return;
    
    // Optimistic UI update: instantly move the order to the new lane
    setOrders(prev => prev.map(o => o.id === orderId ? {
      ...o,
      status: newStatus,
      ...(cancelReason ? { metadata: { ...(o.metadata || {}), cancelReason } } : {}),
    } : o));
    
    // Broadcast status change immediately to all clients (including diner)
    if (ordersChannelRef.current) {
      ordersChannelRef.current.send({
        type: 'broadcast',
        event: 'status-update',
        payload: { orderId, newStatus, ...(cancelReason ? { cancelReason } : {}) },
      });
    }
    
    try {
      if (cancelReason) {
        // Strategy 1: Try to save in metadata column
        const existing = orders.find(o => o.id === orderId);
        const newMetadata = { ...(existing?.metadata || {}), cancelReason };
        const { error: metaErr } = await supabase.from('orders').update({ status: newStatus, metadata: newMetadata }).eq('id', orderId);
        
        if (metaErr && (metaErr.message?.includes('column') || metaErr.code === '42703')) {
          // Strategy 2: metadata column doesn't exist — embed in items array
          const existingItems = existing?.items || [];
          const filteredItems = existingItems.filter(i => i.id !== '__cancel_reason');
          const newItems = [...filteredItems, { id: '__cancel_reason', reason: cancelReason, price: 0, quantity: 0, type: 'metadata' }];
          // Also update local state to include cancelReason in items
          setOrders(prev => prev.map(o => o.id === orderId ? { ...o, items: newItems } : o));
          const { error: itemErr } = await supabase.from('orders').update({ status: newStatus, items: newItems }).eq('id', orderId);
          if (itemErr) throw itemErr;
        } else if (metaErr) {
          throw metaErr;
        }
      } else {
        const { error } = await supabase.from('orders').update({ status: newStatus }).eq('id', orderId);
        if (error) throw error;
      }
      showNotification(`Order moved to: ${newStatus}`);
    } catch (error) { 
      console.error(error);
      showNotification('Failed to update status.');
      
      // Revert change in case of failure
      const { data } = await supabase.from('orders').select('*').order('timestamp', { ascending: false });
      if (data) {
        const mapped = data.map(o => ({
          ...o,
          restId: o.rest_id || o.restId,
          orderType: o.order_type || o.orderType,
          verificationCode: o.verification_code || o.verificationCode,
          contactName: o.contact_name || o.contactName,
          contactPhone: o.contact_phone || o.contactPhone,
          paymentStatus: o.payment_status || o.paymentStatus,
          paymentMethod: o.payment_method || o.paymentMethod,
          scheduledTime: o.scheduled_time || o.scheduledTime,
          tipAmount: o.tip_amount || o.tipAmount,
          tableNumber: o.table_number || o.tableNumber,
        }));
        setOrders(mapped);
      }
    }
  };

  // Dynamically apply active promos to dishes (including per-variant pricing)
  const processedDishes = React.useMemo(() => {
    return dishes.map(dish => {
      const marketing = promos[dish.restId];
      if (!marketing) return dish;

      const applyVariantDiscount = (pct) => {
        if (!dish.variants || dish.variants.length === 0) return null;
        return dish.variants.map(v => {
          const vPrice = parseFloat(v.price) || 0;
          return { ...v, originalPrice: vPrice, price: vPrice - (vPrice * pct) / 100 };
        });
      };

      // 1. Flash Promo (overrides Happy Hour)
      const flash = marketing.flash;
      if (flash && flash.discount > 0 && flash.discount <= 100) {
        const appliesToWholeMenu = !flash.applicableDishes || flash.applicableDishes.length === 0;

        if (dish.variants && dish.variants.length > 0) {
          // Check variant-level applicability (id = "parentId-variantName") OR whole-menu
          const discountedVariants = dish.variants.map(v => {
            const variantVirtualId = `${dish.id}-${v.name}`;
            const applies = appliesToWholeMenu
              || flash.applicableDishes.includes(dish.id)
              || flash.applicableDishes.includes(variantVirtualId);
            if (!applies) return v;
            const vPrice = parseFloat(v.price) || 0;
            return { ...v, originalPrice: vPrice, price: vPrice - (vPrice * flash.discount) / 100 };
          });
          const anyDiscounted = discountedVariants.some(v => v.originalPrice !== undefined);
          if (anyDiscounted) return { ...dish, promoType: 'flash', variants: discountedVariants };
        } else {
          const appliesToDish = appliesToWholeMenu || flash.applicableDishes.includes(dish.id);
          if (appliesToDish) {
            const discountAmt = (dish.price * flash.discount) / 100;
            return { ...dish, originalPrice: dish.price, price: dish.price - discountAmt, promoType: 'flash' };
          }
        }
      }

      // 2. Happy Hour (applies to all dishes / all variants)
      const hh = marketing.happyHour;
      if (hh && hh.startTime && hh.endTime && hh.discount > 0 && hh.discount <= 100) {
        const current = currentTime.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
        const isActive = hh.startTime <= hh.endTime
          ? (current >= hh.startTime && current < hh.endTime)
          : (current >= hh.startTime || current < hh.endTime);

        if (isActive) {
          if (dish.variants && dish.variants.length > 0) {
            const discountedVariants = applyVariantDiscount(hh.discount);
            return { ...dish, promoType: 'happyHour', variants: discountedVariants };
          } else {
            const discountAmt = (dish.price * hh.discount) / 100;
            return { ...dish, originalPrice: dish.price, price: dish.price - discountAmt, promoType: 'happyHour' };
          }
        }
      }

      return dish;
    });
  }, [dishes, promos, currentTime]);

  const value = {
    supabaseUser,
    isInitializing,
    user, setUser,
    activeRestId, setActiveRestId,
    tableNumber, setTableNumber,
    activeDishId, setActiveDishId,
    restaurants, setRestaurants, addRestaurant, updateRestaurant,
    cart, setCart,
    orders, setOrders,
    dishes: processedDishes, setDishes, addDish, updateDish, deleteDish, rsvpToEvent,
    promos, updateMarketingCampaign, currentTime,
    notification, showNotification,
    plans, planFor, upgradePlan,
    serviceAlerts, setServiceAlerts,
    addToCart, removeOneFromCart,
    placeOrder,
    updateOrderStatus,
    favorites, toggleFavorite,
    nutritionHistory, saveNutritionRecord,
    userPreferences, updatePreferences,
    theme, toggleTheme,
    isDataLoaded,
    isOnline,
    offlineQueueSize,
  };

  return (
    <AppContext.Provider value={value}>
      {children}
    </AppContext.Provider>
  );
};
