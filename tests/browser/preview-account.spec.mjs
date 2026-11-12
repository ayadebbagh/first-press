import {test,expect} from 'playwright/test';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';

async function expectCenteredAvatar(page){
  const avatar=page.getByRole('link',{name:'Your account',exact:true});
  await expect(avatar).toBeVisible();
  const offsets=await avatar.evaluate(element=>{
    const outer=element.getBoundingClientRect(),letter=element.querySelector('.avatar-initial').getBoundingClientRect();
    return {x:Math.abs(letter.x+letter.width/2-outer.x-outer.width/2),y:Math.abs(letter.y+letter.height/2-outer.y-outer.height/2)};
  });
  expect(offsets.x,'Account initial is horizontally centered').toBeLessThan(.6);
  expect(offsets.y,'Account initial is vertically centered').toBeLessThan(.6);
  return avatar;
}

test.beforeEach(async({context,page})=>{
  page.__errors=[];page.on('pageerror',error=>page.__errors.push(error.message));
  await context.route('https://fonts.googleapis.com/**',route=>route.fulfill({status:200,contentType:'text/css',body:''}));
});
test.afterEach(async({page})=>expect(page.__errors).toEqual([]));

test('file preview opens its account screen, reloads it and returns without leaving the file',async({page},info)=>{
  const file=pathToFileURL(resolve('FIRST-PRESS-preview.html')).href;
  const authRequests=[];page.on('request',request=>{if(request.url().includes('/api/auth/'))authRequests.push(request.url());});
  await page.goto(file+'#/discover');
  const avatar=await expectCenteredAvatar(page);
  await expect(avatar).toHaveAttribute('href','#/account');
  await page.locator('.topbar').screenshot({path:info.outputPath('preview-account-bubble.png')});
  await avatar.click();
  await expect(page).toHaveURL(file+'#/account');
  await expect(page.getByRole('heading',{name:"You're exploring the demo."})).toBeVisible();
  await expect(page.getByText('FILE PREVIEW',{exact:true})).toBeVisible();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:info.outputPath('preview-account-screen.png'),fullPage:true});
  await page.reload();await expect(page.getByRole('heading',{name:"You're exploring the demo."})).toBeVisible();
  await page.getByRole('link',{name:'Back to discovery'}).click();
  await expect(page).toHaveURL(file+'#/discover');
  await expect(page.getByRole('main')).toBeVisible();
  expect(authRequests,'A file preview never attempts server sign-in').toEqual([]);
});

test('app account link remains a real server route and supports keyboard activation',async({page},info)=>{
  await page.goto('/discover');
  const avatar=await expectCenteredAvatar(page);
  await expect(avatar).toHaveAttribute('href','/account');
  await page.locator('.topbar').screenshot({path:info.outputPath('app-account-bubble.png')});
  await avatar.focus();await page.keyboard.press('Enter');
  await expect(page).toHaveURL('/account');
  await expect(page.getByRole('heading',{name:'Accounts are on their way.'})).toBeVisible();
  await page.getByRole('link',{name:'Back to discovery'}).click();
  await expect(page).toHaveURL('/discover');
});
