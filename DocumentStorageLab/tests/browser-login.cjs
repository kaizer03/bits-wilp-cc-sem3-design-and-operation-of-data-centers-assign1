exports.login=async(page,base,role='editor')=>{
  await page.goto(base);
  await page.locator('#username').fill(role);
  await page.locator('#password').fill(role+'-lab-2026');
  await page.locator('#sign-in-submit').click();
  await page.locator('#app-shell').waitFor({state:'visible'});
  await page.locator('#catalogue-state').filter({hasText:'connected'}).waitFor();
};
