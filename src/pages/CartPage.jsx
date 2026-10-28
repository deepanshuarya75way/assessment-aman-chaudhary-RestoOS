import React, { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { ChevronLeft, ChevronRight, ShoppingCart, MapPin, Clock, Smartphone, CheckCircle2, Store, Trash2, Plus, Minus, Zap, Box, Sparkles, X, Truck, Gift, WifiOff } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import { useAppContext } from '../context/AppContext';
import BottomNav from '../components/BottomNav';
import { supabase } from '../services/supabase';
import { auth } from '../services/firebase';
import { RecaptchaVerifier, signInWithPhoneNumber } from 'firebase/auth';
import LocationPicker from '../components/LocationPicker';
import {validateCart} from '../services/offlineSync';

// ── Combo Image Cycler ─────────────────────────────────────────────────
function ComboImageCycler({ images }) {
  const [idx, setIdx] = React.useState(0);
  const keyRef = React.useRef(images.join(','));

  React.useEffect(() => {
    if (images.length <= 1) return;
    const interval = setInterval(() => {
      setIdx(prev => (prev + 1) % images.length);
    }, 1500);
    return () => clearInterval(interval);
  }, [keyRef.current, images.length]);

  if (!images.length) return (
    <div className="w-14 h-14 rounded-2xl bg-white/5 border border-neutral-200 dark:border-white/10 flex items-center justify-center">
      <ShoppingCart size={20} className="text-neutral-600"/>
    </div>
  );

  return (
    <div className="relative w-14 h-14 rounded-2xl overflow-hidden border border-neutral-200 dark:border-white/10 shrink-0">
      <AnimatePresence mode="popLayout">
        <motion.img
          key={idx}
          src={images[idx]}
          initial={{ opacity: 0, scale: 1.08 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.55, ease: 'easeInOut' }}
          className="absolute inset-0 w-full h-full object-cover"
        />
      </AnimatePresence>
      {images.length > 1 && (
        <div className="absolute bottom-1 left-0 right-0 flex justify-center gap-0.5">
          {images.map((_, i) => (
            <div key={i} className={`w-1 h-1 rounded-full transition-colors ${
              i === idx ? 'bg-white' : 'bg-white/30'
            }`} />
          ))}
        </div>
      )}
    </div>
  );
}


export default function CartPage() {
  const navigate = useNavigate();
  const { cart, setCart, placeOrder, activeRestId, restaurants, planFor, dishes, addToCart, removeOneFromCart, user, setUser, tableNumber, showNotification, isOnline, offlineQueueSize } = useAppContext();
  const [syncWarnings, setSyncWarnings] = useState([]);
  const [showNamePrompt, setShowNamePrompt] = useState(false);
  const [tempName, setTempName] = useState('');
  const [tempPhone, setTempPhone] = useState('');
  const [tempAddress, setTempAddress] = useState('');
  const [locationCoords, setLocationCoords] = useState(null);
  const [isFetchingLocation, setIsFetchingLocation] = useState(false);
  const [showLocationPicker, setShowLocationPicker] = useState(false);
  const [showOtpPrompt, setShowOtpPrompt] = useState(false);
  const [otpCode, setOtpCode] = useState('');
  const [confirmationResult, setConfirmationResult] = useState(null);
  const [isSendingOtp, setIsSendingOtp] = useState(false);
  const [isVerifyingOtp, setIsVerifyingOtp] = useState(false);
  const [otpResendCountdown, setOtpResendCountdown] = useState(0);
  const otpResendTimer = React.useRef(null);
  const { t } = useTranslation();

  const [orderType, setOrderType] = useState(() => (tableNumber === 'delivery' || !tableNumber) ? 'delivery' : 'dine_in');
  const [manualTableNumber, setManualTableNumber] = useState('');

  const isDelivery = orderType === 'delivery';

  const currentRestaurant = restaurants.find(r => r.id === activeRestId);
  const taxRate = currentRestaurant?.taxRate !== undefined 
    ? currentRestaurant.taxRate / 100 
    : (currentRestaurant?.tax_rate !== undefined ? currentRestaurant.tax_rate / 100 : 0.08);

  // ── Delivery fee config from vendor settings ────────────────────────
  const deliveryConfig = currentRestaurant?.macros?.deliveryConfig || {};
  const convenienceFee = isDelivery ? (Number(deliveryConfig.convenienceFee) || 0) : 0;
  const otherFees = isDelivery ? (deliveryConfig.otherFees || []) : [];
  const otherFeesTotal = otherFees.reduce((sum, f) => sum + (Number(f.amount) || 0), 0);
  const baseDeliveryFee = isDelivery ? (Number(deliveryConfig.deliveryFee) || 0) : 0;
  
  useEffect(() => {
    if (!activeRestId) navigate('/', { replace: true });
  }, [activeRestId, navigate]);

  // Pre-initialize RecaptchaVerifier on mount so it's ready instantly when needed
  useEffect(() => {
    const initRecaptcha = () => {
      const container = document.getElementById('recaptcha-container');
      if (!window.recaptchaVerifier && container) {
        try {
          container.innerHTML = '';
          window.recaptchaVerifier = new RecaptchaVerifier(auth, 'recaptcha-container', {
            size: 'invisible',
            callback: () => {},
          });
          window.recaptchaVerifier.render().catch(() => {});
        } catch (e) {
          // silently fail — will retry on sendOtp
        }
      }
    };
    // Slight defer so DOM is ready
    const t = setTimeout(initRecaptcha, 300);
    return () => {
      clearTimeout(t);
      if (otpResendTimer.current) clearInterval(otpResendTimer.current);
    };
  }, []);

  useEffect(() => {
    if (isDelivery && !window.recaptchaVerifier) {
      try {
        const container = document.getElementById('recaptcha-container');
        if (container) container.innerHTML = '';
        window.recaptchaVerifier = new RecaptchaVerifier(auth, 'recaptcha-container', {
          'size': 'invisible'
        });
        window.recaptchaVerifier.render().catch(() => {});
      } catch (e) {}
    }
  }, [isDelivery]);

  const startResendCountdown = () => {
    setOtpResendCountdown(30);
    if (otpResendTimer.current) clearInterval(otpResendTimer.current);
    otpResendTimer.current = setInterval(() => {
      setOtpResendCountdown(prev => {
        if (prev <= 1) { clearInterval(otpResendTimer.current); return 0; }
        return prev - 1;
      });
    }, 1000);
  };

  const subtotal = cart.reduce((sum, item) => {
    return sum + Number(item.price);
  }, 0);
  const taxAmount = subtotal * taxRate;
  const total = subtotal + taxAmount + convenienceFee + baseDeliveryFee + otherFeesTotal;
  
  const resolveFreeDish = (dishIdOrStr, dishesList) => {
    if (!dishIdOrStr) return null;
    const [dishId, variantName] = dishIdOrStr.split('::');
    const d = dishesList.find(x => x.id === dishId);
    if (!d) return null;
    
    if (d.variants && d.variants.length > 0) {
      const v = variantName 
        ? d.variants.find(varItem => varItem.name === variantName)
        : d.variants[0];
      return {
        ...d,
        id: d.id,
        name: v ? `${d.name} (${v.name})` : d.name,
        price: 0,
        quantity: 1,
        isFree: true,
        cover: d.cover || d.images?.[0],
        variantName: v?.name || ''
      };
    }
    return {
      ...d,
      price: 0,
      quantity: 1,
      isFree: true,
      cover: d.cover || d.images?.[0]
    };
  };

  // ── Multi-offer resolution: pick the highest qualifying threshold offer ──
  // Supports both old single-object format and new array format
  const rawOffers = currentRestaurant?.macros?.offers;
  const allOffers = Array.isArray(rawOffers)
    ? rawOffers
    : (rawOffers && rawOffers.freeDishId ? [rawOffers] : []);
  const activeOffers = allOffers.filter(
    o => o.active && Number(o.minOrderValue) > 0 && o.freeDishId
  );
  // Among qualifying offers (subtotal >= threshold), pick the one with highest threshold
  const qualifyingOffers = activeOffers.filter(o => subtotal >= Number(o.minOrderValue));
  const matchedOffer = qualifyingOffers.length > 0
    ? qualifyingOffers.reduce((best, o) => Number(o.minOrderValue) > Number(best.minOrderValue) ? o : best, qualifyingOffers[0])
    : null;
  const freeDishItem = matchedOffer ? resolveFreeDish(matchedOffer.freeDishId, dishes) : null;

  // Track which offerId was last shown so popup re-fires when a higher tier unlocks
  const [lastShownOfferId, setLastShownOfferIdState] = useState(() => {
    return sessionStorage.getItem('3dish_last_shown_offer_id') || null;
  });

  const setLastShownOfferId = (val) => {
    if (val) {
      sessionStorage.setItem('3dish_last_shown_offer_id', val);
    } else {
      sessionStorage.removeItem('3dish_last_shown_offer_id');
    }
    setLastShownOfferIdState(val);
  };
  const [showOffersModal, setShowOffersModal] = useState(false);

  const matchedOfferId = matchedOffer ? (matchedOffer.id || matchedOffer.freeDishId + '_' + matchedOffer.minOrderValue) : null;

  useEffect(() => {
    if (matchedOffer && matchedOfferId !== lastShownOfferId) {
      setShowOffersModal(true);
      setLastShownOfferId(matchedOfferId);
    } else if (!matchedOffer) {
      setLastShownOfferId(null);
    }
  }, [matchedOfferId]);
  
  
  const groupedCart = Object.values(cart.reduce((acc, item) => {
    const groupId = item.id + (item.selectedVariant ? '-' + item.selectedVariant.name : '') + (item.customizationId ? '-' + item.customizationId : '');
    if (!acc[groupId]) {
      acc[groupId] = { ...item, quantity: 0, cartIds: [], groupId };
      if (item.selectedVariant) {
        acc[groupId].variantName = item.selectedVariant.name;
      }
    }
    acc[groupId].quantity += 1;
    acc[groupId].cartIds.push(item.cartId);
    if (!acc[groupId].specialInstructions && item.specialInstructions) {
        acc[groupId].specialInstructions = item.specialInstructions;
    }
    return acc;
  }, {}));

  const [specialInstructions, setSpecialInstructions] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);
  const [showArCombo, setShowArCombo] = useState(false);
  const [paymentMethod, setPaymentMethod] = useState('Pay at Counter');

  const hasSoldOutItem = cart.some(item => {
    const dbDish = dishes.find(d => d.id === item.id);
    return dbDish?.tags?.includes('sold_out');
  });

  // ── Subscription plan gate ──
  const PLANS = ['Starter', 'Pro', 'Enterprise'];
  const restaurantPlan = planFor ? planFor(activeRestId) : 'Starter';
  const hasEnterprise = PLANS.indexOf(restaurantPlan) >= PLANS.indexOf('Enterprise');

  const cartWithModels = hasEnterprise ? cart.filter(c => c.modelUrl || c.model_url) : [];

  if (cart.length === 0) {
    return (
      <div className="flex flex-col h-[100dvh] items-center justify-center pb-20 bg-white dark:bg-black text-neutral-900 dark:text-pearl font-sans">
        <motion.div initial={{ scale: 0.8, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} className="flex flex-col items-center">
          <div className="w-24 h-24 rounded-full flex items-center justify-center mb-6 bg-white/5 border border-neutral-200 dark:border-white/10 shadow-[0_0_40px_rgba(255,255,255,0.05)]">
            <ShoppingCart size={36} className="text-neutral-500" />
          </div>
          <p className="font-display font-black text-2xl text-neutral-900 dark:text-white mb-2">Cart is empty</p>
          <p className="text-neutral-500 text-sm mb-8">Ready to explore the interactive menu?</p>
          <button onClick={() => navigate('/menu')}
            className="font-sans font-bold px-8 py-4 rounded-2xl transition-all bg-gradient-to-r from-[#D4AF37] to-[#AA8C2C] text-neutral-900 dark:text-white shadow-[0_10px_30px_rgba(212,175,55,0.3)] ">
            Browse Menu
          </button>
        </motion.div>
        <BottomNav/>
      </div>
    );
  }

  const executeCheckout = async ({ overrideName, overridePhone, overrideAddress, overrideCoords } = {}) => {
    if (!isDelivery && (tableNumber === 'delivery' || !tableNumber) && !manualTableNumber) {
      showNotification('Please enter your table number.');
      return;
    }

    const finalName = overrideName || user?.name || (() => { try { return JSON.parse(localStorage.getItem('3dish_diner_profile') || '{}').name; } catch(e) {} })();
    const finalPhone = overridePhone || user?.phone || (() => { try { return JSON.parse(localStorage.getItem('3dish_diner_profile') || '{}').phone; } catch(e) {} })();
    const resolvedCoords = overrideCoords || locationCoords;
    const resolvedAddress = overrideAddress || tempAddress;

    // Strict Gate: Delivery ALWAYS requires OTP verification (which passes overrideName).
    // If overrideName is missing and it's delivery, force the prompt.
    if (isDelivery && !overrideName) {
      setShowNamePrompt(true);
      return;
    }
    
    const missingDeliveryInfo = isDelivery && !resolvedCoords && !resolvedAddress;
    if (!finalName || !finalPhone || missingDeliveryInfo) {
      setShowNamePrompt(true);
      return;
    }

    setIsProcessing(true);

    const {valid, warnings, updatedCart} = validateCart(card, dishes);
    if(warnings.length > 0) {
      setSyncWarnings(warnings);

      if(!valid) {
        const validIds = new Set(updatedCart.map(i => i.cartId));
        setCart(prev => prev.filter(i => validIds.has(i.cardId)));
        setIsProcessing(false);
        return;
      }
      if(updatedCart.some((item, idx) => item.price !== cart[idx]?.price)) {
        setCart(prev => prev.map(item => {
          const updated = updatedCart.find(u => u.cardId === item.cartId);
          return updated ? {...item, price: updated.price} :item;
        }));
        setIsProcessing(false);
        return;
      }
    } else {
      setSyncWarnings([]);
    }

    // ── Verification Code Logic ─────────────────────────────────────────
    // This 4-digit code is ONLY for DINE-IN orders.
    // • DINE-IN: code is generated only when the vendor's toggle is ON.
    // • DELIVERY: code is NEVER generated — delivery has its own SMS/OTP verification
    //             (enforced via Firebase at the sendOtp/verifyOtp flow above).
    //   The vendor's "Customer Verification Code" toggle has NO effect on delivery.
    const requireCode = !isDelivery && (currentRestaurant?.requireVerificationCode === true || String(currentRestaurant?.requireVerificationCode) === 'true');
    const code = requireCode ? Math.floor(1000 + Math.random() * 9000).toString() : null;
    // Delivery always goes to 'Pending' (never 'Pending Verification')
    // Dine-in always goes to 'Pending Verification' (Awaiting Approval)
    const status = isDelivery ? 'Pending' : 'Pending Verification';
    const finalPaymentStatus = 'Unpaid';
    
    // Encode GPS into specialInstructions as a fallback (guaranteed to survive any DB schema)
    let finalSpecialInstructions = specialInstructions;
    if (isDelivery && resolvedCoords) {
      const coordStr = `GPS:${resolvedCoords.lat},${resolvedCoords.lng}`;
      finalSpecialInstructions = finalSpecialInstructions ? `${finalSpecialInstructions} | ${coordStr}` : coordStr;
    }

    let meta = {};
    if (isDelivery) {
      meta.address = resolvedAddress;
      if (resolvedCoords) meta.location = resolvedCoords;
    }

    const success = await placeOrder({ 
      orderType: isDelivery ? 'delivery' : 'dine_in', 
      scheduledTime: null,
      paymentMethod: isDelivery ? 'Pay on Delivery' : paymentMethod,
      paymentStatus: finalPaymentStatus,
      status: status,
      tipAmount: 0,
      verificationCode: code,
      contactName: finalName,
      contactPhone: finalPhone,
      specialInstructions: finalSpecialInstructions,
      metadata: meta,
      tableNumber: !isDelivery && manualTableNumber ? manualTableNumber : tableNumber
    });
    
    setIsProcessing(false);
    if (success) {
      setCart([]);
      navigate('/orders');
    }
  };

  const handleFetchLocation = () => {
    if (!navigator.geolocation) {
      showNotification("Geolocation is not supported by your browser");
      return;
    }
    setIsFetchingLocation(true);
    navigator.geolocation.getCurrentPosition(
      async (position) => {
        const lat = position.coords.latitude;
        const lng = position.coords.longitude;
        setLocationCoords({ lat, lng });

        // Reverse geocode via Nominatim (OpenStreetMap) - no API key needed
        try {
          const res = await fetch(
            `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}&addressdetails=1`,
            { headers: { 'Accept-Language': 'en', 'User-Agent': '3Dish-DeliveryApp/1.0' } }
          );
          const data = await res.json();
          const readableAddr = data.display_name || `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
          // Embed GPS tag in address string — survives even if metadata column is absent
          setTempAddress(`${readableAddr} [GPS:${lat},${lng}]`);
          showNotification("📍 Location detected: " + (data.address?.suburb || data.address?.village || data.address?.city || 'Address found'));
        } catch (geoErr) {
          // Nominatim failed — fallback to raw coords still embedded in address
          setTempAddress(`GPS Location [GPS:${lat},${lng}]`);
          showNotification("Location detected successfully!");
        }
        setIsFetchingLocation(false);
      },
      (error) => {
        console.warn('Geolocation error:', error);
        let errorMsg = "Failed to detect location. Please enter your address manually.";
        if (error.code === 1) errorMsg = "Location permission denied. Please allow location access in your browser settings.";
        else if (error.code === 2) errorMsg = "Location unavailable. Please check your device GPS.";
        else if (error.code === 3) errorMsg = "Location request timed out. Please try again or type manually.";
        showNotification(errorMsg);
        setIsFetchingLocation(false);
      },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 10000 }
    );
  };



  const sendOtp = async (isResend = false) => {
    const missingDeliveryInfo = isDelivery && !locationCoords && !tempAddress;
    if (!tempName || !tempPhone || missingDeliveryInfo) {
      showNotification('Please fill in all required details.');
      return;
    }

    let formattedPhone = tempPhone.trim();
    if (!formattedPhone.startsWith('+')) {
      formattedPhone = `+91${formattedPhone}`;
    }

    setIsSendingOtp(true);
    try {
      // FIX: Always destroy and recreate the recaptcha verifier to avoid stale iframe issues in React
      if (window.recaptchaVerifier) {
        try { window.recaptchaVerifier.clear(); } catch (e) {}
        window.recaptchaVerifier = null;
      }
      
      const container = document.getElementById('recaptcha-container');
      if (container) container.innerHTML = ''; 
      
      window.recaptchaVerifier = new RecaptchaVerifier(auth, 'recaptcha-container', { size: 'invisible' });
      await window.recaptchaVerifier.render();
      
      const appVerifier = window.recaptchaVerifier;
      const result = await signInWithPhoneNumber(auth, formattedPhone, appVerifier);
      
      setConfirmationResult(result);
      setShowOtpPrompt(true);
      setOtpCode('');
      startResendCountdown();
      showNotification(isResend ? '🔄 New OTP sent to your phone!' : '📱 OTP sent to your phone!');
    } catch (error) {
      console.error('Error sending OTP:', error);
      // Suppress the confusing ReCaptcha internal error message from being shown to user
      const isRecaptchaError = error.message && error.message.includes('reCAPTCHA');
      showNotification(isRecaptchaError ? 'Verification failed. Please try again.' : (error.message || 'Failed to send OTP. Please check the number or try again.'));

      // Reset ReCaptcha so the user can try again
      if (window.recaptchaVerifier) {
        try { window.recaptchaVerifier.clear(); } catch (e) {}
        window.recaptchaVerifier = null;
      }
      // Re-initialize safely for next attempt
      try {
        const container = document.getElementById('recaptcha-container');
        if (container) container.innerHTML = '';
        window.recaptchaVerifier = new RecaptchaVerifier(auth, 'recaptcha-container', { size: 'invisible' });
        window.recaptchaVerifier.render().catch(() => {});
      } catch(e) {}
    }
    setIsSendingOtp(false);
  };

  const verifyOtp = async (codeOverride) => {
    const code = codeOverride || otpCode;
    if (!code || code.length < 6) {
      showNotification('Please enter a valid 6-digit OTP.');
      return;
    }

    setIsVerifyingOtp(true);
    try {
      await confirmationResult.confirm(code);
      showNotification('✅ Phone number verified!');

      const guestId = user?.uid || user?.guestId || 'guest_' + Math.random().toString(36).substr(2, 9) + '_' + Date.now();
      const profile = { guestId, name: tempName, phone: tempPhone, firstVisit: new Date().toISOString() };
      localStorage.setItem('3dish_diner_profile', JSON.stringify(profile));
      if (setUser) setUser(prev => ({ ...prev, name: tempName, phone: tempPhone, role: 'diner', guestId }));

      if (otpResendTimer.current) clearInterval(otpResendTimer.current);
      setShowOtpPrompt(false);
      setShowNamePrompt(false);

      executeCheckout({
        overrideName: tempName,
        overridePhone: tempPhone,
        overrideAddress: tempAddress,
        overrideCoords: locationCoords,
      });
    } catch (error) {
      console.error('Error verifying OTP:', error);
      showNotification('❌ Invalid OTP. Please check and try again.');
    }
    setIsVerifyingOtp(false);
  };

  

  const handleBack = () => {
    navigate(-1);
  };

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      className="flex flex-col h-[100dvh] bg-white dark:bg-black text-neutral-900 dark:text-pearl font-sans relative">
      
      {/* SaaS Grid Background */}
      <div className="absolute inset-0 opacity-[0.02] pointer-events-none"
        style={{ backgroundImage: 'linear-gradient(rgba(255, 255, 255, 0.5) 1px, transparent 1px), linear-gradient(90deg, rgba(255, 255, 255, 0.5) 1px, transparent 1px)', backgroundSize: '40px 40px' }} />

      {/* Header */}
      <div className="p-6 pt-14 sticky top-0 z-20 bg-white dark:bg-black/80 backdrop-blur-xl border-b border-neutral-200 dark:border-white/5">
        <div className="flex items-center gap-4">
          <button onClick={handleBack}
            className="w-10 h-10 rounded-full flex items-center justify-center transition-all bg-white/5 border border-neutral-200 dark:border-white/10 hover:bg-white/10">
            <ChevronLeft size={20} className="text-neutral-900 dark:text-white" />
          </button>
          <h1 className="text-2xl font-display font-black text-neutral-900 dark:text-white tracking-tight">Checkout</h1>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-6 pt-6 pb-36 z-10 no-scrollbar">
        <motion.div key="cart" initial={{ x: -20, opacity: 0 }} animate={{ x: 0, opacity: 1 }} exit={{ x: -20, opacity: 0 }} className="space-y-4">

          <AnimatePresence>
            {!isOnline && (
              <motion.div
                initial={{opacity:0, y:-8}} animate={{opacity:1,y:0}} exit={{opacity:0, y:-8}}
                className="flex items-center gap-3 px-4 py-3 rounded-2xl bg-amber-500/10 border border-amber-500/30 text-amber-600 dark:text-amber-400 text-sm font-medium"
              >
                <WifiOff size={16}/>
              </motion.div>
            )}
          </AnimatePresence>

          {/* Manual Table Number input for Dine-in when no table number scanned */}
          {!isDelivery && (tableNumber === 'delivery' || !tableNumber) && (
            <div className="bg-neutral-50 dark:bg-[#111] border border-neutral-200 dark:border-white/5 rounded-[2rem] p-5 shadow-md space-y-2">
              <label className="block text-xs font-bold text-neutral-500 uppercase tracking-wider">Table Number *</label>
              <input
                type="number"
                value={manualTableNumber}
                onChange={e => setManualTableNumber(e.target.value.replace(/\D/g, ''))}
                placeholder="Enter Table Number (e.g. 5)"
                className="w-full bg-white dark:bg-[#0a0a0a] border border-[#D4AF37]/35 rounded-xl p-3 text-sm focus:outline-none focus:border-[#D4AF37] dark:text-white"
              />
              <p className="text-[10px] text-neutral-400">Please enter your table number to place a dine-in order.</p>
            </div>
          )}

          <div className="flex justify-between items-center mb-4">
            <h2 className="text-lg font-display font-bold text-neutral-900 dark:text-white">Your Order</h2>
          </div>
          
          {groupedCart.map((item) => {
            const customizationTotal = (item.selectedCustomizations || []).reduce((sum, c) => sum + (Number(c.price) || 0), 0);
            const itemBasePrice = item.basePrice !== undefined ? item.basePrice : (Number(item.price) - customizationTotal);

            // ── Combo image slideshow ──
            const comboDishIds = item.macros?.comboDishes || [];
            const comboImages = comboDishIds.length > 0
              ? comboDishIds
                  .map(idStr => {
                    const dishId = typeof idStr === 'string' ? idStr.split('::')[0] : idStr;
                    const d = dishes.find(d => d.id === dishId);
                    return d?.cover || d?.images?.[0] || null;
                  })
                  .filter(Boolean)
              : [];
            const isCombo = comboDishIds.length > 0; // Fix: use comboDishIds.length, not images length, to know it's a combo
            // Fall back: if combo but children have no images, try own cover
            const singleImage = item.cover || item.images?.[0];

            return (
            <motion.div layout key={item.groupId || item.id}
              drag="x" dragConstraints={{ left: -80, right: 0 }}
              onDragEnd={(e, info) => { if (info.offset.x < -50) setCart(cart.filter(c => c.id !== item.id)); }}
              className="relative flex items-center bg-neutral-50 dark:bg-[#111] border border-neutral-200 dark:border-white/5 rounded-3xl p-4 shadow-md cursor-grab active:cursor-grabbing group">
              
              {/* Swipe to delete background indicator */}
              <div className="absolute inset-y-0 right-0 w-20 flex items-center justify-center bg-red-500/20 text-red-500 rounded-r-3xl border border-red-500/20 opacity-0 group-active:opacity-100 transition-opacity pointer-events-none">
                <Trash2 size={20} />
              </div>

              <div className="relative z-10 flex-1 flex flex-col bg-neutral-50 dark:bg-[#111] w-full rounded-3xl gap-3">
                <div className="flex justify-between items-start">
                  <div className="flex items-center gap-4">
                    {isCombo ? (
                      <ComboImageCycler images={comboImages} />
                    ) : singleImage ? (
                      <img src={singleImage} className="w-14 h-14 rounded-2xl object-cover border border-neutral-200 dark:border-white/10 shrink-0" />
                    ) : (
                      <div className="w-14 h-14 rounded-2xl bg-white/5 border border-neutral-200 dark:border-white/10 flex items-center justify-center shrink-0"><ShoppingCart size={20} className="text-neutral-600"/></div>
                    )}
                    <div>
                      <h3 className="font-bold text-neutral-900 dark:text-white font-sans max-w-[150px] leading-tight mb-1">{item.name}</h3>
                      {item.variantName && (
                        <p className="text-xs font-bold text-[#D4AF37] mb-1">{item.variantName}</p>
                      )}
                      {/* Customization pills */}
                      {item.selectedCustomizations && item.selectedCustomizations.length > 0 && (
                        <div className="flex flex-wrap gap-1 mb-1">
                          {item.selectedCustomizations.map((c, ci) => (
                            <span key={ci} className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-md text-[9px] font-bold" style={{ background: 'rgba(212,175,55,0.08)', color: '#D4AF37', border: '1px solid rgba(212,175,55,0.2)' }}>
                              {c.name}{Number(c.price) > 0 ? ` +₹${Number(c.price).toFixed(0)}` : ''}
                            </span>
                          ))}
                        </div>
                      )}
                      <div className="flex items-center gap-2">
                        {dishes.find(d => d.id === item.id)?.tags?.includes('sold_out') && (
                          <span className="px-2 py-0.5 rounded-full bg-red-100 dark:bg-red-900/30 text-red-600 dark:text-red-400 font-bold text-[9px] uppercase tracking-wider">
                            Sold Out
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                  <div className="text-right flex flex-col items-end gap-1.5">
                    <div className="flex flex-col items-end text-right">
                      {item.originalPrice && item.originalPrice > item.price && (
                        <span className="text-neutral-400 dark:text-neutral-500 line-through text-xs font-medium">
                          ₹{(Number(item.originalPrice) * item.quantity).toFixed(0)}
                        </span>
                      )}
                      <span className="text-xs text-neutral-500 font-medium leading-none mb-1">
                        ₹{(itemBasePrice * item.quantity).toFixed(0)}
                      </span>
                      {customizationTotal > 0 && (
                        <span className="text-[10px] text-neutral-400 dark:text-neutral-500 font-semibold mb-1">
                          + ₹{(customizationTotal * item.quantity).toFixed(0)}
                        </span>
                      )}
                      <span className="font-black text-lg text-[#D4AF37] leading-none mt-0.5">₹{(Number(item.price) * item.quantity).toFixed(0)}</span>
                    </div>
                    {/* Stepper */}
                    <div className="flex items-center bg-emerald-50 dark:bg-emerald-900/20 border border-emerald-200 dark:border-emerald-800/50 rounded-lg overflow-hidden">
                      <button onClick={(e) => { e.stopPropagation(); removeOneFromCart(item.id, item.variantName, item.customizationId); }} className="px-2.5 py-1 text-emerald-600 dark:text-emerald-400 hover:bg-emerald-100 dark:hover:bg-emerald-800/50 transition-colors">
                        <Minus size={14} strokeWidth={2.5} />
                      </button>
                      <span className="px-2 text-sm font-bold text-emerald-700 dark:text-emerald-300 w-6 text-center">{item.quantity}</span>
                      <button onClick={(e) => { e.stopPropagation(); addToCart(item); }} className="px-2.5 py-1 text-emerald-600 dark:text-emerald-400 hover:bg-emerald-100 dark:hover:bg-emerald-800/50 transition-colors">
                        <Plus size={14} strokeWidth={2.5} />
                      </button>
                    </div>
                  </div>
                </div>
                

              </div>
            </motion.div>
            );
          })}

          {freeDishItem && (
            <motion.div layout key="free-dish-gift"
              initial={{ scale: 0.95, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              className="relative flex items-center bg-emerald-50/30 dark:bg-emerald-950/10 border border-emerald-500/35 rounded-3xl p-4 shadow-md group">
              <div className="relative z-10 flex-1 flex flex-col w-full rounded-3xl gap-3">
                <div className="flex justify-between items-start">
                  <div className="flex items-center gap-4">
                    {freeDishItem.cover ? (
                      <img src={freeDishItem.cover} className="w-14 h-14 rounded-2xl object-cover border border-emerald-500/20 shrink-0" />
                    ) : (
                      <div className="w-14 h-14 rounded-2xl bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center shrink-0">
                        <Gift size={20} className="text-emerald-500"/>
                      </div>
                    )}
                    <div>
                      <div className="flex items-center gap-2 flex-wrap">
                        <h3 className="font-bold text-neutral-900 dark:text-white font-sans max-w-[150px] leading-tight mb-0.5">{freeDishItem.name}</h3>
                        <span className="px-2 py-0.5 rounded-full bg-emerald-500 text-white font-bold text-[9px] uppercase tracking-wider flex items-center gap-0.5">
                          🎁 Free Gift
                        </span>
                      </div>
                      {freeDishItem.variantName && (
                        <p className="text-xs font-bold text-emerald-500 mb-1">{freeDishItem.variantName}</p>
                      )}
                      <p className="text-[10px] text-neutral-400">Added surprise gift for order value &gt; ₹{matchedOffer?.minOrderValue}</p>
                    </div>
                  </div>
                  <div className="text-right flex flex-col items-end gap-1.5">
                    <div className="flex flex-col items-end text-right">
                      {(() => {
                        const originalPrice = freeDishItem.variantName
                          ? (freeDishItem.variants?.find(v => v.name === freeDishItem.variantName)?.price || freeDishItem.price)
                          : freeDishItem.price;
                        return originalPrice > 0 && (
                          <span className="text-neutral-400 dark:text-neutral-500 line-through text-xs font-medium">
                            ₹{Number(originalPrice).toFixed(0)}
                          </span>
                        );
                      })()}
                      <span className="font-black text-lg text-emerald-500 leading-none mt-0.5">FREE</span>
                    </div>
                  </div>
                </div>
              </div>
            </motion.div>
          )}

          <p className="text-center text-xs text-neutral-500 py-2">Swipe items left to remove</p>

          <div className="mt-6 mb-6 pt-6 border-t border-neutral-200 dark:border-white/5">
            <h3 className="font-display font-bold text-neutral-900 dark:text-white text-sm mb-3">Order Note</h3>
            <textarea
              value={specialInstructions}
              onChange={(e) => setSpecialInstructions(e.target.value)}
              placeholder="e.g. Leave at door, call when arrived..."
              className="w-full bg-neutral-50 dark:bg-[#0a0a0a] border border-neutral-200 dark:border-white/10 rounded-2xl p-4 text-sm text-neutral-900 dark:text-white placeholder:text-neutral-600 focus:outline-none focus:border-[#D4AF37]/40 transition-all min-h-[100px] resize-none"
            />
          </div>
          
          {/* AR Combo Builder Button */}
          {cartWithModels.length > 0 && (
            <motion.button 
              whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.98 }}
              onClick={() => setShowArCombo(true)}
              className="mt-2 w-full py-3.5 rounded-[2rem] border border-purple-500/30 bg-gradient-to-r from-purple-500/10 to-indigo-500/10 text-indigo-600 dark:text-indigo-400 font-bold flex justify-center items-center gap-2 transition-all">
              <Box size={18} /> View {cartWithModels.length} Item Combo in AR
            </motion.button>
          )}

          {/* Receipt Summary */}
          <div className="mt-4 bg-white/5 border border-neutral-200 dark:border-white/10 rounded-[2rem] p-6 backdrop-blur-md">
            <div className="flex justify-between text-neutral-500 dark:text-neutral-400 text-sm mb-3"><span>Subtotal</span><span>₹{subtotal.toFixed(0)}</span></div>
            <div className="flex justify-between text-neutral-500 dark:text-neutral-400 text-sm mb-3"><span>Tax ({Math.round(taxRate * 100)}%)</span><span>₹{taxAmount.toFixed(0)}</span></div>
            {isDelivery && baseDeliveryFee > 0 && (
              <div className="flex justify-between text-neutral-500 dark:text-neutral-400 text-sm mb-3">
                <span className="flex items-center gap-1.5"><Truck size={13}/>Delivery Fee</span>
                <span>₹{baseDeliveryFee.toFixed(0)}</span>
              </div>
            )}
            {isDelivery && convenienceFee > 0 && (
              <div className="flex justify-between text-neutral-500 dark:text-neutral-400 text-sm mb-3">
                <span>Convenience Fee</span>
                <span>₹{convenienceFee.toFixed(0)}</span>
              </div>
            )}
            {isDelivery && otherFees.map((f, i) => f.amount > 0 && (
              <div key={i} className="flex justify-between text-neutral-500 dark:text-neutral-400 text-sm mb-3">
                <span>{f.label || 'Other Fee'}</span>
                <span>₹{Number(f.amount).toFixed(0)}</span>
              </div>
            ))}
            {freeDishItem && (
              <div className="flex justify-between text-emerald-500 font-bold text-sm mb-3">
                <span className="flex items-center gap-1.5">🎁 Free {freeDishItem.name}</span>
                <span>₹0</span>
              </div>
            )}
            <div className="border-t border-neutral-200 dark:border-white/10 pt-4 mt-2 text-2xl font-black flex justify-between text-neutral-900 dark:text-white font-display items-center">
              <span>Total</span>
              <span className="text-[#D4AF37] text-3xl">₹{total.toFixed(0)}</span>
            </div>
            {/* Loyalty Points display */}
            <div className="mt-4 pt-4 border-t border-neutral-200 dark:border-white/10 flex items-center justify-between">
              <div className="flex items-center gap-2 text-[#D4AF37]">
                <Zap size={16} className="animate-pulse" />
                <span className="text-sm font-black uppercase tracking-widest">XP Points</span>
              </div>
              <span className="text-sm font-bold text-[#D4AF37]">+150 XP</span>
            </div>
          </div>

          {/* Payment Method Selector */}
          {!isDelivery && (
            <div className="mt-4 mb-8 bg-white/5 border border-neutral-200 dark:border-white/10 rounded-[2rem] p-5 backdrop-blur-md">
              <h3 className="font-display font-bold text-neutral-900 dark:text-white text-sm mb-3">Payment Method</h3>
              <div 
                onClick={() => setPaymentMethod('Pay at Counter')}
                className={`flex items-center gap-4 p-4 rounded-2xl cursor-pointer border-2 transition-all ${
                  paymentMethod === 'Pay at Counter' 
                    ? 'border-[#D4AF37] bg-[#D4AF37]/10' 
                    : 'border-transparent bg-neutral-100 dark:bg-white/5'
                }`}
              >
                <div className="w-10 h-10 rounded-full flex items-center justify-center bg-white dark:bg-black shadow-sm">
                  <Store size={18} className="text-[#D4AF37]" />
                </div>
                <div className="flex-1">
                  <p className="font-bold text-neutral-900 dark:text-white text-sm">Pay at Counter</p>
                  <p className="text-xs text-neutral-500">Pay with Cash, Card, or UPI after your meal.</p>
                </div>
                <div className={`w-5 h-5 rounded-full border-2 flex items-center justify-center ${paymentMethod === 'Pay at Counter' ? 'border-[#D4AF37] bg-[#D4AF37]' : 'border-neutral-300 dark:border-neutral-600'}`}>
                  {paymentMethod === 'Pay at Counter' && <div className="w-2 h-2 bg-white rounded-full" />}
                </div>
              </div>
            </div>
          )}

          {/* Name Prompt Modal for old profiles */}
          <AnimatePresence>
            {showNamePrompt && (
              <div className="fixed inset-0 z-[999] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
                <motion.div
                  initial={{ opacity: 0, scale: 0.9, y: 20 }}
                  animate={{ opacity: 1, scale: 1, y: 0 }}
                  exit={{ opacity: 0, scale: 0.9, y: 20 }}
                  className="bg-white dark:bg-[#12141D] w-full max-w-sm rounded-[2rem] p-5 sm:p-6 shadow-2xl border border-neutral-200 dark:border-white/10 relative flex flex-col max-h-[85dvh] overflow-hidden"
                >
                  <div className="absolute -top-10 -right-10 w-40 h-40 bg-[#D4AF37]/20 blur-3xl rounded-full pointer-events-none" />
                  
                  <div className="text-center mb-4 sm:mb-6 relative z-10 shrink-0">
                    <h2 className="font-display font-black text-2xl text-neutral-900 dark:text-white">Almost there!</h2>
                    <p className="text-sm text-neutral-500 mt-1">Please enter your details to complete the order.</p>
                  </div>
                  
                  <div className="space-y-4 relative z-10 overflow-y-auto no-scrollbar pb-2 px-1">
                    {!showOtpPrompt ? (
                      <>
                        <div>
                          <label className="block text-xs font-bold text-neutral-500 mb-1.5 uppercase tracking-wider">Your Name</label>
                          <input autoFocus type="text" value={tempName} onChange={e => setTempName(e.target.value)} placeholder="e.g. John Doe"
                            className="w-full bg-neutral-50 dark:bg-[#0a0a0a] border border-neutral-200 dark:border-white/10 rounded-xl p-3 text-sm focus:outline-none focus:border-[#D4AF37] dark:text-white" />
                        </div>
                        <div>
                          <label className="block text-xs font-bold text-neutral-500 mb-1.5 uppercase tracking-wider">Phone Number</label>
                          <input type="tel" value={tempPhone} onChange={e => setTempPhone(e.target.value)} placeholder="e.g. 9876543210"
                            className="w-full bg-neutral-50 dark:bg-[#0a0a0a] border border-neutral-200 dark:border-white/10 rounded-xl p-3 text-sm focus:outline-none focus:border-[#D4AF37] dark:text-white" />
                        </div>
                        {isDelivery && (
                          <div className="pt-2 border-t border-neutral-200 dark:border-white/10">
                            <label className="block text-xs font-bold text-neutral-500 mb-1.5 uppercase tracking-wider">Delivery Location <span className="text-red-500">*</span></label>
                            <button
                              type="button"
                              onClick={() => setShowLocationPicker(true)}
                              className={`w-full flex items-center gap-3 p-3 rounded-xl border text-left transition-all ${
                                tempAddress
                                  ? 'border-emerald-500 bg-emerald-50/50 dark:bg-emerald-950/20'
                                  : 'border-neutral-200 dark:border-white/10 bg-neutral-50 dark:bg-[#0a0a0a] hover:border-[#D4AF37]/50'
                              }`}
                            >
                              <div className={`w-8 h-8 rounded-full flex items-center justify-center shrink-0 ${
                                tempAddress ? 'bg-emerald-100 dark:bg-emerald-900/30' : 'bg-neutral-200 dark:bg-white/10'
                              }`}>
                                <MapPin size={15} className={tempAddress ? 'text-emerald-600 dark:text-emerald-400' : 'text-neutral-500'} />
                              </div>
                              <div className="flex-1 min-w-0">
                                {tempAddress
                                  ? <>
                                      <p className="text-[10px] font-black text-emerald-600 dark:text-emerald-400 uppercase tracking-wider mb-0.5">Location Selected ✓</p>
                                      <p className="text-xs font-bold text-neutral-800 dark:text-white truncate">{tempAddress.replace(/\s*\[GPS:[^\]]+\]/, '').trim()}</p>
                                    </>
                                  : <>
                                      <p className="text-xs font-bold text-neutral-700 dark:text-neutral-300">Select delivery location</p>
                                      <p className="text-[10px] text-neutral-400 mt-0.5">Search, use GPS or pin on map</p>
                                    </>
                                }
                              </div>
                              <ChevronRight size={14} className="text-neutral-400 shrink-0" />
                            </button>
                          </div>
                        )}
                        <button 
                          onClick={() => {
                            if (isDelivery) {
                              sendOtp();
                            } else {
                              const missingDeliveryInfo = isDelivery && !locationCoords && !tempAddress;
                              if (tempName && tempPhone && !missingDeliveryInfo) {
                                const guestId = user?.uid || user?.guestId || 'guest_' + Math.random().toString(36).substr(2, 9) + '_' + Date.now();
                                const profile = { guestId, name: tempName, phone: tempPhone, firstVisit: new Date().toISOString() };
                                localStorage.setItem('3dish_diner_profile', JSON.stringify(profile));
                                if (setUser) setUser(prev => ({ ...prev, name: tempName, phone: tempPhone, role: 'diner', guestId }));
                                setShowNamePrompt(false);
                                executeCheckout({
                                  overrideName: tempName,
                                  overridePhone: tempPhone,
                                  overrideAddress: tempAddress,
                                  overrideCoords: locationCoords,
                                });
                              } else {
                                showNotification("Please fill in all required details.");
                              }
                            }
                          }}
                          disabled={isSendingOtp}
                          className="w-full py-3.5 mt-2 rounded-xl bg-[#D4AF37] text-black font-black text-base hover:bg-amber-400 transition-colors shadow-lg shadow-amber-500/20 disabled:opacity-50">
                          {isSendingOtp ? "Sending OTP..." : (isDelivery ? "Send OTP to Verify" : "Save & Checkout")}
                        </button>
                        <button 
                          onClick={() => setShowNamePrompt(false)}
                          className="w-full py-3 mt-1 text-sm text-neutral-500 hover:text-neutral-900 dark:hover:text-white transition-colors">
                          Cancel
                        </button>
                      </>
                    ) : (
                      // ── OTP Entry Screen ──
                      <>
                        {/* Header */}
                        <div className="text-center mb-5">
                          <div className="w-14 h-14 rounded-2xl bg-[#D4AF37]/10 border border-[#D4AF37]/20 flex items-center justify-center mx-auto mb-3">
                            <Smartphone size={26} className="text-[#D4AF37]" />
                          </div>
                          <p className="text-base font-black text-neutral-900 dark:text-white">Enter Verification Code</p>
                          <p className="text-xs text-neutral-500 mt-1">
                            Sent via SMS to{' '}
                            <span className="font-black text-neutral-700 dark:text-neutral-300">
                              +91 {tempPhone.replace(/^\+91/, '')}
                            </span>
                          </p>
                        </div>

                        {/* OTP Input — large, numeric, auto-submit on 6 digits */}
                        <div className="relative">
                          <input
                            autoFocus
                            inputMode="numeric"
                            pattern="[0-9]*"
                            type="tel"
                            maxLength={6}
                            value={otpCode}
                            onChange={e => {
                              const val = e.target.value.replace(/\D/g, '').slice(0, 6);
                              setOtpCode(val);
                              // Auto-submit as soon as 6 digits entered
                              if (val.length === 6) verifyOtp(val);
                            }}
                            placeholder="––  ––  ––"
                            className="w-full text-center tracking-[0.6em] font-display font-black text-3xl bg-neutral-50 dark:bg-[#0a0a0a] border-2 border-neutral-200 dark:border-white/10 rounded-2xl py-5 px-4 focus:outline-none focus:border-[#D4AF37] dark:text-white transition-colors"
                          />
                          {isVerifyingOtp && (
                            <div className="absolute inset-0 flex items-center justify-center bg-white/80 dark:bg-black/80 rounded-2xl">
                              <div className="flex gap-1.5">
                                {[0,1,2].map(i => (
                                  <motion.div key={i} animate={{ scale: [1, 1.4, 1], opacity: [0.4, 1, 0.4] }}
                                    transition={{ duration: 0.8, repeat: Infinity, delay: i * 0.2 }}
                                    className="w-2.5 h-2.5 rounded-full bg-[#D4AF37]" />
                                ))}
                              </div>
                            </div>
                          )}
                        </div>

                        {/* Helpful hints about SMS + spam */}
                        <div className="space-y-2">
                          <div className="bg-blue-50 dark:bg-blue-900/15 border border-blue-200 dark:border-blue-500/20 rounded-xl p-3 flex gap-2.5">
                            <span className="text-base shrink-0">💬</span>
                            <div>
                              <p className="text-xs font-bold text-blue-700 dark:text-blue-400">Check your SMS / Messages app</p>
                              <p className="text-[11px] text-blue-600/80 dark:text-blue-400/70 mt-0.5 leading-relaxed">
                                The OTP arrives as a text message. It usually takes 5–20 seconds. Do not close this screen.
                              </p>
                            </div>
                          </div>
                          <div className="bg-amber-50 dark:bg-amber-900/10 border border-amber-200 dark:border-amber-500/20 rounded-xl p-3 flex gap-2.5">
                            <span className="text-base shrink-0">📂</span>
                            <div>
                              <p className="text-xs font-bold text-amber-700 dark:text-amber-400">OTP not received?</p>
                              <p className="text-[11px] text-amber-600/80 dark:text-amber-400/70 mt-0.5 leading-relaxed">
                                Some carriers filter OTP messages into a <span className="font-black">Spam</span> or <span className="font-black">Promotions</span> folder. Please check there if you don't see it in your inbox.
                              </p>
                            </div>
                          </div>
                        </div>

                        {/* Manual verify button (shown only if not auto-submitted) */}
                        {!isVerifyingOtp && otpCode.length > 0 && otpCode.length < 6 && (
                          <button
                            onClick={() => verifyOtp()}
                            disabled={isVerifyingOtp}
                            className="w-full py-3.5 rounded-xl bg-[#D4AF37] text-black font-black text-base hover:bg-amber-400 transition-colors shadow-lg shadow-amber-500/20 flex items-center justify-center gap-2 disabled:opacity-50">
                            <CheckCircle2 size={18} /> Verify & Place Order
                          </button>
                        )}

                        {/* Resend OTP */}
                        <div className="text-center pt-1">
                          {otpResendCountdown > 0 ? (
                            <p className="text-xs text-neutral-400">
                              Resend OTP in{' '}
                              <span className="font-black text-[#D4AF37]">{otpResendCountdown}s</span>
                            </p>
                          ) : (
                            <button
                              onClick={() => sendOtp(true)}
                              disabled={isSendingOtp}
                              className="text-xs font-black text-[#D4AF37] hover:text-amber-500 transition-colors underline underline-offset-2 disabled:opacity-50">
                              {isSendingOtp ? 'Sending...' : '🔄 Resend OTP'}
                            </button>
                          )}
                        </div>

                        {/* Change number */}
                        <button
                          onClick={() => { setShowOtpPrompt(false); setOtpCode(''); if (otpResendTimer.current) clearInterval(otpResendTimer.current); }}
                          className="w-full py-2 text-xs text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-300 transition-colors">
                          ← Change phone number
                        </button>
                      </>
                    )}
                  </div>
                </motion.div>
              </div>
            )}
          </AnimatePresence>

        </motion.div>
      </div>

      <AnimatePresence>
        {showArCombo && cartWithModels.length > 0 && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0 z-[100] bg-black/95 flex flex-col items-center justify-center p-6 backdrop-blur-md">
             <button onClick={() => setShowArCombo(false)} className="absolute top-6 right-6 text-white bg-white/10 rounded-full p-2 hover:bg-white/20 transition-colors">
               <X size={24}/>
             </button>
             <h2 className="text-white font-display font-black text-2xl mb-2 flex items-center gap-2">
               <Sparkles className="text-purple-400"/> AR Combo View
             </h2>
             <p className="text-neutral-400 text-sm mb-6 text-center max-w-[250px]">Previewing {cartWithModels.length} items from your cart together.</p>
             
             <div className="w-full max-w-md h-[50vh] bg-white/5 rounded-[2rem] border border-white/10 overflow-hidden relative shadow-2xl">
                <model-viewer
                  src={cartWithModels[0].modelUrl || cartWithModels[0].model_url}
                  auto-rotate
                  camera-controls
                  ar
                  ar-modes="webxr scene-viewer quick-look"
                  style={{ width: '100%', height: '100%' }}
                />
                <div className="absolute bottom-4 left-4 right-4 bg-black/60 backdrop-blur-md rounded-2xl p-3 flex justify-between items-center border border-white/10">
                  <span className="text-white text-xs font-bold truncate max-w-[70%]">{cartWithModels.map(c => c.name).join(', ')}</span>
                  <Box size={16} className="text-purple-400"/>
                </div>
             </div>
             
             <button onClick={() => {
                const mv = document.querySelector('model-viewer');
                if(mv && mv.activateAR) mv.activateAR();
             }}
             className="mt-6 w-full max-w-md py-4 rounded-2xl font-black bg-white text-black shadow-lg">
               Launch AR Mode
             </button>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {showOffersModal && freeDishItem && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0 z-[110] bg-black/80 flex flex-col items-center justify-center p-6 backdrop-blur-md">
            
            <motion.div 
              initial={{ scale: 0.9, y: 20, opacity: 0 }}
              animate={{ scale: 1, y: 0, opacity: 1 }}
              exit={{ scale: 0.9, y: 20, opacity: 0 }}
              className="relative w-full max-w-sm rounded-[2.5rem] overflow-hidden border border-emerald-500/35 bg-white dark:bg-[#0d0d0f] shadow-2xl p-6 text-center space-y-6"
            >
              {/* Confetti decoration */}
              <div className="absolute inset-0 pointer-events-none overflow-hidden opacity-30">
                <div className="absolute top-4 left-6 w-3 h-3 rounded-full bg-yellow-400 animate-ping" />
                <div className="absolute top-10 right-12 w-4 h-4 rounded-full bg-emerald-400 animate-ping" style={{ animationDelay: '0.5s' }} />
                <div className="absolute bottom-16 left-12 w-2.5 h-2.5 rounded-full bg-pink-400 animate-ping" style={{ animationDelay: '1s' }} />
              </div>

              {/* Gift icon floating */}
              <motion.div 
                animate={{ y: [0, -10, 0] }}
                transition={{ duration: 3, repeat: Infinity, ease: "easeInOut" }}
                className="w-20 h-20 rounded-full bg-gradient-to-tr from-emerald-500 to-teal-400 flex items-center justify-center mx-auto shadow-lg shadow-emerald-500/20"
              >
                <Gift size={38} className="text-white" />
              </motion.div>

              <div className="space-y-2">
                <h3 className="font-display font-black text-2xl text-neutral-900 dark:text-white leading-tight">Surprise Gift Unlocked! 🎉</h3>
                <p className="text-xs text-neutral-500 max-w-[260px] mx-auto">
                  Your order exceeds the ₹{matchedOffer?.minOrderValue} limit! We've added this delicious dish completely free of charge.
                </p>
              </div>

              {/* Dish item display card */}
              <div className="bg-neutral-50 dark:bg-white/5 border border-neutral-200 dark:border-white/5 rounded-3xl p-4 flex items-center gap-4 text-left">
                {freeDishItem.cover ? (
                  <img src={freeDishItem.cover} className="w-16 h-16 rounded-2xl object-cover border border-neutral-200 dark:border-white/10 shrink-0" />
                ) : (
                  <div className="w-16 h-16 rounded-2xl bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center shrink-0">
                    <Gift size={24} className="text-emerald-500" />
                  </div>
                )}
                <div className="flex-1 min-w-0">
                  <span className="text-[10px] font-black text-emerald-500 uppercase tracking-widest block mb-0.5">Free Surprise Dish</span>
                  <h4 className="font-bold text-sm text-neutral-900 dark:text-white truncate">{freeDishItem.name}</h4>
                  {freeDishItem.variantName && (
                    <p className="text-xs font-bold text-emerald-500 mt-0.5">{freeDishItem.variantName}</p>
                  )}
                  {(() => {
                    const price = freeDishItem.variantName
                      ? (freeDishItem.variants?.find(v => v.name === freeDishItem.variantName)?.price || freeDishItem.price)
                      : freeDishItem.price;
                    return price > 0 && (
                      <p className="text-xs text-neutral-400 line-through mt-0.5">Worth: ₹{Number(price).toFixed(0)}</p>
                    );
                  })()}
                </div>
              </div>

              <button 
                onClick={() => setShowOffersModal(false)}
                className="w-full py-4 rounded-2xl font-display font-black text-base bg-gradient-to-r from-emerald-500 to-teal-500 text-white shadow-lg shadow-emerald-500/20 hover:opacity-90 transition-opacity"
              >
                Awesome, Thank You! ✨
              </button>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Floating Action Button Footer */}
      {!showNamePrompt && (
        <div className="fixed bottom-0 left-0 w-full p-6 pt-10 pb-24 z-30 pointer-events-none"
          style={{ background: 'linear-gradient(to top, rgba(9,10,15,1) 30%, rgba(9,10,15,0.8) 70%, transparent 100%)' }}>
        
        <div className="pointer-events-auto flex flex-col gap-3">
          <motion.button 
            disabled={hasSoldOutItem || isProcessing}
            whileHover={hasSoldOutItem ? undefined : { scale: 1.02 }} 
            whileTap={hasSoldOutItem ? undefined : { scale: 0.98 }} 
            onClick={executeCheckout}
            className={`w-full font-sans font-black py-5 rounded-2xl transition-all flex items-center justify-center ${
              hasSoldOutItem 
                ? 'bg-neutral-200 dark:bg-neutral-800 text-neutral-400 dark:text-neutral-500 cursor-not-allowed border border-neutral-300 dark:border-neutral-700' 
                : 'bg-gradient-to-r from-[#D4AF37] to-[#AA8C2C] text-neutral-900 dark:text-white shadow-[0_10px_30px_rgba(212,175,55,0.3)]'
            }`}
          >
            {hasSoldOutItem ? 'Remove Sold Out Items to Proceed' : (isProcessing ? (
              <><motion.div animate={{ rotate: 360 }} transition={{ repeat: Infinity, ease: 'linear', duration: 1 }} className="w-5 h-5 border-2 rounded-full border-white/30 border-t-white mr-2" /> Processing...</>
            ) : (isDelivery ? 'Proceed to Verification' : 'Make Order'))}
          </motion.button>
        </div>
      </div>
      )}

      <div id="recaptcha-container"></div>
      <BottomNav />

      <LocationPicker
        isOpen={showLocationPicker}
        onClose={() => setShowLocationPicker(false)}
        onLocationConfirmed={({ address, coords }) => {
          // Store coords object separately for precise order metadata
          setLocationCoords(coords);
          // Also embed GPS tag in address string as a reliable fallback for vendor dashboard parsing
          // (matches the same format as handleFetchLocation's [GPS:lat,lng] tag)
          const addrWithGps = coords
            ? `${address} [GPS:${coords.lat},${coords.lng}]`
            : address;
          setTempAddress(addrWithGps);
          setShowLocationPicker(false);
        }}
      />
    </motion.div>
  );
}
