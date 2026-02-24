export interface Subcategory {
  id: string;
  name: string;
}

export interface Category {
  id: string;
  name: string;
  emoji: string;
  subcategories: Subcategory[];
}

export const CATEGORIES: Category[] = [
  // ── Food & Groceries ──────────────────────────────────────
  {
    id: 'fruits-vegetables',
    name: 'Fruits & Vegetables',
    emoji: '🥬',
    subcategories: [
      { id: 'fresh-fruits', name: 'Fresh Fruits' },
      { id: 'fresh-vegetables', name: 'Fresh Vegetables' },
      { id: 'dried-fruits', name: 'Dried Fruits' },
      { id: 'mushrooms', name: 'Mushrooms' },
      { id: 'herbs-fresh', name: 'Fresh Herbs' },
      { id: 'salads-prepared', name: 'Prepared Salads' },
    ],
  },
  {
    id: 'dairy-eggs',
    name: 'Dairy & Eggs',
    emoji: '🥛',
    subcategories: [
      { id: 'milk', name: 'Milk' },
      { id: 'cheese', name: 'Cheese' },
      { id: 'yogurt', name: 'Yogurt' },
      { id: 'butter-cream', name: 'Butter & Cream' },
      { id: 'eggs', name: 'Eggs' },
    ],
  },
  {
    id: 'meat-poultry',
    name: 'Meat & Poultry',
    emoji: '🥩',
    subcategories: [
      { id: 'beef', name: 'Beef' },
      { id: 'pork', name: 'Pork' },
      { id: 'chicken', name: 'Chicken' },
      { id: 'turkey', name: 'Turkey' },
      { id: 'lamb', name: 'Lamb' },
      { id: 'deli-meats', name: 'Deli Meats' },
      { id: 'sausages', name: 'Sausages' },
      { id: 'game', name: 'Game' },
    ],
  },
  {
    id: 'fish-seafood',
    name: 'Fish & Seafood',
    emoji: '🐟',
    subcategories: [
      { id: 'fresh-fish', name: 'Fresh Fish' },
      { id: 'canned-fish', name: 'Canned Fish' },
      { id: 'shellfish', name: 'Shellfish' },
      { id: 'smoked-fish', name: 'Smoked Fish' },
    ],
  },
  {
    id: 'bakery-bread',
    name: 'Bakery & Bread',
    emoji: '🍞',
    subcategories: [
      { id: 'bread', name: 'Bread' },
      { id: 'pastries', name: 'Pastries' },
      { id: 'cakes', name: 'Cakes' },
      { id: 'tortillas-wraps', name: 'Tortillas & Wraps' },
      { id: 'bagels-rolls', name: 'Bagels & Rolls' },
    ],
  },
  {
    id: 'pasta-rice-grains',
    name: 'Pasta, Rice & Grains',
    emoji: '🍝',
    subcategories: [
      { id: 'pasta', name: 'Pasta' },
      { id: 'rice', name: 'Rice' },
      { id: 'cereal', name: 'Cereal & Muesli' },
      { id: 'oats-porridge', name: 'Oats & Porridge' },
      { id: 'couscous-quinoa', name: 'Couscous & Quinoa' },
      { id: 'flour', name: 'Flour' },
    ],
  },
  {
    id: 'canned-jarred',
    name: 'Canned & Jarred Goods',
    emoji: '🥫',
    subcategories: [
      { id: 'canned-vegetables', name: 'Canned Vegetables' },
      { id: 'canned-beans-legumes', name: 'Beans & Legumes' },
      { id: 'canned-soups', name: 'Soups' },
      { id: 'canned-sauces', name: 'Pasta Sauces' },
      { id: 'canned-fruit', name: 'Canned Fruit' },
      { id: 'pickles-preserves', name: 'Pickles & Preserves' },
    ],
  },
  {
    id: 'condiments-spices',
    name: 'Condiments & Spices',
    emoji: '🧂',
    subcategories: [
      { id: 'sauces', name: 'Sauces' },
      { id: 'oils', name: 'Oils' },
      { id: 'vinegar', name: 'Vinegar' },
      { id: 'dressings', name: 'Dressings' },
      { id: 'herbs-spices', name: 'Herbs & Spices' },
      { id: 'mustard-ketchup', name: 'Mustard & Ketchup' },
      { id: 'salt-pepper', name: 'Salt & Pepper' },
    ],
  },
  {
    id: 'snacks-sweets',
    name: 'Snacks & Sweets',
    emoji: '🍫',
    subcategories: [
      { id: 'chips-crisps', name: 'Chips & Crisps' },
      { id: 'chocolate', name: 'Chocolate' },
      { id: 'candy', name: 'Candy' },
      { id: 'nuts-seeds', name: 'Nuts & Seeds' },
      { id: 'cookies-biscuits', name: 'Cookies & Biscuits' },
      { id: 'crackers', name: 'Crackers' },
      { id: 'popcorn', name: 'Popcorn' },
      { id: 'granola-bars', name: 'Granola & Energy Bars' },
    ],
  },
  {
    id: 'beverages',
    name: 'Beverages',
    emoji: '🥤',
    subcategories: [
      { id: 'water', name: 'Water' },
      { id: 'juice', name: 'Juice' },
      { id: 'soda-soft-drinks', name: 'Soda & Soft Drinks' },
      { id: 'coffee', name: 'Coffee' },
      { id: 'tea', name: 'Tea' },
      { id: 'energy-sports-drinks', name: 'Energy & Sports Drinks' },
      { id: 'milk-alternatives', name: 'Milk Alternatives' },
    ],
  },
  {
    id: 'alcohol',
    name: 'Alcohol',
    emoji: '🍷',
    subcategories: [
      { id: 'beer', name: 'Beer' },
      { id: 'wine', name: 'Wine' },
      { id: 'spirits', name: 'Spirits' },
      { id: 'liqueurs', name: 'Liqueurs' },
      { id: 'cider', name: 'Cider' },
    ],
  },
  {
    id: 'frozen-foods',
    name: 'Frozen Foods',
    emoji: '🧊',
    subcategories: [
      { id: 'frozen-meals', name: 'Frozen Meals' },
      { id: 'ice-cream', name: 'Ice Cream' },
      { id: 'frozen-vegetables', name: 'Frozen Vegetables' },
      { id: 'frozen-pizza', name: 'Frozen Pizza' },
      { id: 'frozen-meat-fish', name: 'Frozen Meat & Fish' },
      { id: 'frozen-bakery', name: 'Frozen Bakery' },
    ],
  },
  {
    id: 'baking',
    name: 'Baking Supplies',
    emoji: '🧁',
    subcategories: [
      { id: 'sugar-sweeteners', name: 'Sugar & Sweeteners' },
      { id: 'baking-mixes', name: 'Baking Mixes' },
      { id: 'baking-chocolate', name: 'Baking Chocolate' },
      { id: 'yeast-leaveners', name: 'Yeast & Leaveners' },
    ],
  },
  {
    id: 'spreads-breakfast',
    name: 'Spreads & Breakfast',
    emoji: '🍯',
    subcategories: [
      { id: 'jam-marmalade', name: 'Jam & Marmalade' },
      { id: 'honey', name: 'Honey' },
      { id: 'peanut-butter', name: 'Nut Butters' },
      { id: 'nutella-chocolate-spreads', name: 'Chocolate Spreads' },
    ],
  },
  {
    id: 'meat-alternatives',
    name: 'Meat Alternatives',
    emoji: '🌱',
    subcategories: [
      { id: 'tofu-tempeh', name: 'Tofu & Tempeh' },
      { id: 'plant-based-meat', name: 'Plant-based Meat' },
      { id: 'veggie-burgers', name: 'Veggie Burgers' },
    ],
  },
  {
    id: 'baby-kids',
    name: 'Baby & Kids',
    emoji: '🍼',
    subcategories: [
      { id: 'baby-food', name: 'Baby Food' },
      { id: 'baby-formula', name: 'Baby Formula' },
      { id: 'diapers-wipes', name: 'Diapers & Wipes' },
      { id: 'baby-care', name: 'Baby Care' },
    ],
  },
  // ── Non-Food ──────────────────────────────────────────────
  {
    id: 'household',
    name: 'Household & Cleaning',
    emoji: '🧹',
    subcategories: [
      { id: 'cleaning-products', name: 'Cleaning Products' },
      { id: 'paper-products', name: 'Paper Products' },
      { id: 'laundry', name: 'Laundry' },
      { id: 'trash-bags', name: 'Trash Bags' },
      { id: 'kitchen-supplies', name: 'Kitchen Supplies' },
    ],
  },
  {
    id: 'personal-care',
    name: 'Personal Care',
    emoji: '🧴',
    subcategories: [
      { id: 'hygiene', name: 'Hygiene' },
      { id: 'dental', name: 'Dental Care' },
      { id: 'hair-care', name: 'Hair Care' },
      { id: 'skincare', name: 'Skincare' },
      { id: 'cosmetics', name: 'Cosmetics' },
    ],
  },
  {
    id: 'health-pharmacy',
    name: 'Health & Pharmacy',
    emoji: '💊',
    subcategories: [
      { id: 'vitamins-supplements', name: 'Vitamins & Supplements' },
      { id: 'medicine', name: 'Medicine' },
      { id: 'first-aid', name: 'First Aid' },
    ],
  },
  {
    id: 'pet-care',
    name: 'Pet Care',
    emoji: '🐾',
    subcategories: [
      { id: 'pet-food', name: 'Pet Food' },
      { id: 'pet-treats', name: 'Pet Treats' },
      { id: 'pet-supplies', name: 'Pet Supplies' },
    ],
  },
  // ── Non-Grocery Spending ──────────────────────────────────
  {
    id: 'dining',
    name: 'Dining & Restaurants',
    emoji: '🍽️',
    subcategories: [
      { id: 'restaurants', name: 'Restaurants' },
      { id: 'fast-food', name: 'Fast Food' },
      { id: 'cafes', name: 'Cafes & Coffee Shops' },
      { id: 'delivery', name: 'Delivery & Takeout' },
    ],
  },
  {
    id: 'clothing',
    name: 'Clothing & Apparel',
    emoji: '👕',
    subcategories: [
      { id: 'clothes', name: 'Clothes' },
      { id: 'shoes', name: 'Shoes' },
      { id: 'accessories', name: 'Accessories' },
      { id: 'sportswear', name: 'Sportswear' },
    ],
  },
  {
    id: 'electronics',
    name: 'Electronics & Tech',
    emoji: '💻',
    subcategories: [
      { id: 'devices', name: 'Devices' },
      { id: 'accessories-tech', name: 'Accessories' },
      { id: 'software-subscriptions', name: 'Software & Subscriptions' },
    ],
  },
  {
    id: 'home-garden',
    name: 'Home & Garden',
    emoji: '🏠',
    subcategories: [
      { id: 'furniture', name: 'Furniture' },
      { id: 'decor', name: 'Decor' },
      { id: 'tools-hardware', name: 'Tools & Hardware' },
      { id: 'garden', name: 'Garden' },
    ],
  },
  {
    id: 'sports-outdoors',
    name: 'Sports & Outdoors',
    emoji: '⚽',
    subcategories: [
      { id: 'equipment', name: 'Equipment' },
      { id: 'fitness', name: 'Fitness' },
      { id: 'outdoor-gear', name: 'Outdoor Gear' },
    ],
  },
  {
    id: 'entertainment',
    name: 'Entertainment',
    emoji: '🎬',
    subcategories: [
      { id: 'books', name: 'Books' },
      { id: 'games-toys', name: 'Games & Toys' },
      { id: 'media', name: 'Media' },
      { id: 'events-tickets', name: 'Events & Tickets' },
    ],
  },
  {
    id: 'transportation',
    name: 'Transportation',
    emoji: '🚗',
    subcategories: [
      { id: 'fuel', name: 'Fuel' },
      { id: 'parking', name: 'Parking' },
      { id: 'public-transit', name: 'Public Transit' },
      { id: 'car-maintenance', name: 'Car Maintenance' },
    ],
  },
  {
    id: 'other',
    name: 'Other',
    emoji: '📦',
    subcategories: [],
  },
];

// Lookup maps for fast access
const categoryMap = new Map<string, Category>();
const subcategoryMap = new Map<string, { subcategory: Subcategory; parent: Category }>();

for (const cat of CATEGORIES) {
  categoryMap.set(cat.id, cat);
  for (const sub of cat.subcategories) {
    subcategoryMap.set(sub.id, { subcategory: sub, parent: cat });
  }
}

export function getCategoryById(id: string): Category | undefined {
  return categoryMap.get(id);
}

export function getSubcategoryById(id: string): { subcategory: Subcategory; parent: Category } | undefined {
  return subcategoryMap.get(id);
}

/**
 * Builds a compact category reference string for use in LLM prompts.
 */
export function buildCategoryPromptList(): string {
  return CATEGORIES.map(cat => {
    const subs = cat.subcategories.map(s => s.id).join(', ');
    return subs
      ? `${cat.id}: ${cat.name} [${subs}]`
      : `${cat.id}: ${cat.name}`;
  }).join('\n');
}
