import {test,expect} from 'playwright/test';

// Every test gets a fresh browser context and private localStorage. No personal
// browser profile or founder account is opened or modified.
test.beforeEach(async({context,page})=>{
  const errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  page.on('console',message=>{if(message.type()==='error')errors.push(message.text());});
  page.__firstPressErrors=errors;
  // App behavior and local assets are real. Provider availability/audio and
  // optional Google fonts are outside these deterministic app tests.
  await context.route('**/*',route=>{
    const url=new URL(route.request().url());
    if(url.hostname==='127.0.0.1')return route.continue();
    if(route.request().resourceType()==='stylesheet')return route.fulfill({status:200,contentType:'text/css',body:''});
    return route.fulfill({status:200,contentType:'text/html',body:'<!doctype html><title>External provider test fixture</title>'});
  });
});
test.afterEach(async({page})=>{expect(page.__firstPressErrors,'Browser console and hydration errors').toEqual([]);});

async function openArtist(page,id,name){
  await page.goto('/artist/'+id);
  await expect(page.getByRole('heading',{level:1,name,exact:true})).toBeVisible();
}
async function queueBuy(page){
  await openArtist(page,'artist_005','che');
  await page.getByRole('button',{name:'Back che',exact:true}).click();
  await page.getByLabel('CREDITS TO BACK',{exact:true}).fill('250');
  await page.getByRole('button',{name:'Queue backing',exact:true}).click();
  await expect(page).toHaveURL('/collection');
  await expect(page.locator('.order-row')).toHaveCount(1);
}
async function update(page){
  await page.getByRole('button',{name:'Try the next update',exact:true}).click();
  await page.getByRole('button',{name:/^Run demo update/}).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
}

test('root redirect, direct routes, keyboard entry and 404',async({page,request})=>{
  await page.goto('/');
  await expect(page).toHaveURL('/discover');
  await expect(page.getByRole('main')).toBeVisible();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link',{name:'Skip to content'})).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('main')).toBeFocused();
  for(const route of ['/catalog','/tracks','/collection','/receipts','/daily','/artist/artist_005']){
    await page.goto(route);
    await expect(page.getByRole('main')).toBeVisible();
    await expect(page.locator('h1')).toHaveCount(1);
  }
  expect((await request.get('/does-not-exist')).status()).toBe(404);
});

test('all 50 catalog pictures decode and the page fits its viewport',async({page},testInfo)=>{
  await page.goto('/catalog');
  const pictures=page.locator('.catalog-grid .portrait img');
  await expect(pictures).toHaveCount(50);
  for(const picture of await pictures.all()){
    await picture.scrollIntoViewIfNeeded();
    await expect.poll(()=>picture.evaluate(img=>img.complete&&img.naturalWidth>0)).toBe(true);
  }
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
  await page.evaluate(()=>scrollTo(0,0));
  await page.screenshot({path:testInfo.outputPath('catalog.png')});
});

test('previously missing portraits survive direct artist links',async({page},testInfo)=>{
  for(const [id,name] of [['artist_005','che'],['artist_014','bleood'],['artist_032','quinn'],['artist_049','untiljapan'],['artist_050','damon r.']]){
    await openArtist(page,id,name);
    const image=page.locator('.artist-photo-large img');
    await expect(image).toBeVisible();
    await expect.poll(()=>image.evaluate(img=>img.complete&&img.naturalWidth>0)).toBe(true);
    await expect(image).toHaveAttribute('src',`/assets/${id}.jpg`);
  }
  await page.screenshot({path:testInfo.outputPath('artist.png')});
});

test('a failed picture keeps an accessible fallback',async({page})=>{
  await page.route('**/assets/artist_005.jpg',route=>route.fulfill({status:200,contentType:'image/jpeg',body:'invalid image fixture'}));
  await openArtist(page,'artist_005','che');
  await expect(page.getByRole('img',{name:'che picture unavailable',exact:true})).toBeVisible();
  await expect(page.locator('.artist-photo-large img')).toHaveCount(0);
  await openArtist(page,'artist_017','Feng');
  await expect(page.locator('.artist-photo-large img')).toBeVisible();
});

test('keyboard search, watchlist persistence and dialog focus',async({page})=>{
  await page.goto('/catalog');
  await expect(page.getByRole('main')).toBeVisible();
  await page.keyboard.press('/');
  const search=page.getByRole('searchbox',{name:'Search catalog'});
  await expect(search).toBeFocused();
  await search.fill('Feng');
  await expect(page.locator('.artist-card')).toHaveCount(1);
  await page.getByRole('button',{name:'Add Feng to watchlist',exact:true}).click();
  await page.reload();
  await page.getByRole('button',{name:'Watchlist',exact:true}).click();
  await expect(page.locator('.artist-card')).toHaveCount(1);
  await expect(page.getByRole('button',{name:'Remove Feng from watchlist',exact:true})).toHaveAttribute('aria-pressed','true');
  const trigger=page.getByRole('button',{name:'Request an artist',exact:true});
  await trigger.click();
  await expect(page.getByLabel('ARTIST NAME',{exact:true})).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(trigger).toBeFocused();
});

test('queued buy, cancellation, settlement, exit and retained receipt',async({page},testInfo)=>{
  await queueBuy(page);
  await expect(page.locator('.collection-stat').filter({hasText:'AVAILABLE CREDITS'}).locator('strong')).toHaveText(/750\s*CR/);
  await page.getByRole('button',{name:/^Cancel/}).click();
  await expect(page.locator('.order-row')).toHaveCount(0);
  await expect(page.locator('.collection-stat').filter({hasText:'AVAILABLE CREDITS'}).locator('strong')).toHaveText(/1,000\s*CR/);
  await queueBuy(page);
  await update(page);
  await expect(page.locator('.holding-row')).toHaveCount(1);
  await page.reload();
  await expect(page.locator('.holding-row')).toHaveCount(1);
  await page.locator('.holding-row').getByRole('button',{name:/^Sell/}).click();
  await page.getByLabel('PERCENTAGE OF AVAILABLE BACKING',{exact:true}).fill('100');
  await page.getByRole('button',{name:'Queue sale',exact:true}).click();
  await update(page);
  await expect(page.locator('.holding-row')).toHaveCount(0);
  await page.goto('/receipts');
  await expect(page.locator('.receipt-card')).toHaveCount(1);
  await expect(page.locator('.receipt-card')).toContainText('che');
  await page.reload();
  await expect(page.locator('.receipt-card')).toHaveCount(1);
  await page.screenshot({path:testInfo.outputPath('receipt.png')});
});

test('daily votes, editable prediction and locked demo result persist',async({page})=>{
  await page.goto('/daily');
  for(let i=0;i<4;i++)await page.getByRole('button',{name:'This is my pick',exact:true}).first().click();
  await expect(page.getByRole('heading',{level:1,name:'CALL THE ORDER.'})).toBeVisible();
  await page.getByRole('button',{name:'Move fakemink down',exact:true}).click();
  await expect(page.locator('.rank-row').first()).toContainText('2hollis');
  await page.getByRole('button',{name:'Reveal demo ranking',exact:true}).click();
  await expect(page.getByText('DEMO RANKING · NOT LIVE COMMUNITY RESULTS',{exact:true})).toBeVisible();
  await expect(page.locator('.rank-controls')).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole('heading',{level:1,name:'YOUR CALL IS IN.'})).toBeVisible();
});

test('Dreamflasher keeps the original Spotify recording',async({page})=>{
  await openArtist(page,'artist_003','Jane Remover');
  await page.locator('.artist-track').filter({hasText:'Dreamflasher'}).click();
  await expect(page.locator('iframe.spotify-player')).toHaveAttribute('src',/\/embed\/track\/75Wgg4LerPD3mVO5hEyUN9/);
  await expect(page.locator('iframe.soundcloud-player')).toHaveCount(0);
  await expect(page.getByRole('link',{name:/Open this recording on Spotify/})).toHaveAttribute('href','https://open.spotify.com/track/75Wgg4LerPD3mVO5hEyUN9');
});
