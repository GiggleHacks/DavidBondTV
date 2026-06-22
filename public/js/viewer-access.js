export function isAdminUser(user) {
  return !!(user && Array.isArray(user.roles) && user.roles.includes('admin'));
}

export function canUserWatchPremium(user) {
  if (!user) return false;
  if (isAdminUser(user)) return true;
  return !!(user.membership && user.membership.active);
}

/** Does this user own any of the given products? (one-time course/bundle/digital) */
export function ownsAnyProduct(user, productIds) {
  if (!user || !Array.isArray(productIds) || !productIds.length) return false;
  const owned = Array.isArray(user.ownedProductIds) ? user.ownedProductIds : [];
  return productIds.some((id) => owned.includes(id));
}

/**
 * The single access decision used everywhere (player, grid, server mirrors it).
 * Precedence: admin > course-ownership > premium-membership > free.
 * `productIdsForVideo` = published product ids this video is assigned to. When a
 * video is course-assigned, OWNERSHIP is the binding gate — membership is
 * irrelevant for it (courses are a separate purchase).
 */
export function canWatchVideo(user, entry, productIdsForVideo) {
  if (isAdminUser(user)) return true;
  if (Array.isArray(productIdsForVideo) && productIdsForVideo.length) {
    return ownsAnyProduct(user, productIdsForVideo);
  }
  return entry && entry.visibility === 'premium' ? canUserWatchPremium(user) : true;
}
