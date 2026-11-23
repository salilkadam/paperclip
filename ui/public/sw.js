// The build id is stamped into this file at production build time (see
// stampServiceWorkerBuildId in vite.config.ts), so a deploy that changes only
// the app bundle still changes sw.js byte-for-byte. That is what makes the
// browser install a new worker, which — via skipWaiting + controllerchange —
// reloads parked tabs onto the fresh bundle. Left as the literal placeholder in
// dev, where HMR (not the worker) drives refreshes.
const BUILD_ID = "__PAPERCLIP_BUILD_ID__";
const OFFLINE_STYLES = "__PAPERCLIP_OFFLINE_STYLES__";
// Separate this allowlisted cache from older workers that cached arbitrary URLs.
const CACHE_NAME = `paperclip-public-assets-${BUILD_ID}`;
const privateRequests = new Set();
const privateCacheControl = /(?:^|,)\s*(?:no-store|private)(?:\s*(?:,|=)|\s*$)/i;

// Static recovery only: never cache or embed authenticated page content here.
function offlineNavigationResponse() {
  return new Response(`<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark"><title>Bionic is offline</title>
<style>${OFFLINE_STYLES}</style></head>
<body class="paperclip-offline"><main aria-labelledby="offline-title">
<div class="paperclip-offline-message">
<div class="paperclip-offline-identity">
<svg class="paperclip-offline-character" aria-hidden="true" viewBox="0 0 256 256" xmlns="http://www.w3.org/2000/svg"><image width="256" height="256" href="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAQAAAAEACAYAAABccqhmAAAmvUlEQVR42u2debxsVXXnv6eq7vDe4z2GB/hA5kFABRxAHIjEEDVBIx3T4pD4SWI0tho1mGiS7qQd0u0QzSd2YtpEjRqbRI1+YpOkG8VGkGZoxFZQ1CAzvAfIG3jzu+/eqnP6j712n1377nOq7lRV997f7/M5n7r3VtUZ9l3rt4a99trZ5s2PIAjC6kRDQyAIIgBBEEQAgiCIAARBEAEIgiACEARBBCAIgghAEAQRgCAIIgBBEEQAgiCIAARBEAEIgiACEARBBCAIgghAEAQRgCAIIgBBEEQAgiCIAARBEAEIgiACEARBBCAIgghAEAQRgCAIIgBBEEQAgiCIAARBEAEIgiACEARBBCAIgghAEAQRgCAIIgBBEEQAgiCIAARBEAEIgghAEAQRgCAIIgBBEEQAgiCIAARBEAEIgiACEARBBCAIgghAEAQRgCAIIgBBEEQAgiCIAARBEAEIgiACEARBBCAIgghAEAQRgCAIIgBBEEQAgiCIAARBEAEIgiACEARBBCAIgghAEIRFR0sESG4/Z9F7Rc33ssTnsh7fWenIeoxd1ufYCiKAgSGvUfoMaAKd6P0sUvos+k4RCXyxypR/Pu8LIoCRE9wiUP5GjaKHxOB/LiJyWAkkUAzpu4IIYCiC3bRjJvIChDSRxkdIlLkdIgIRwMgKcOjebwTOBc4EnmCfeRyYsmM3sA+YtmMmEPJQ6BvAWCJUSF0/t3ONGjmGR9sOr8wzwF579UQ5U3O+sei8uTwEEcAoWX//+zSwFVhjAr8JOA04FTjZCGI/sM2IIBUC+L+1EiFEFQHMjFi8nEfP07G/te39NrDHxsuT435gJ/AosB3YYT8/nCAHL38dkcCQLN/mzY9oFEoLXVQI4iRwvHkEZwHPAs4DTtTQJdExxd9uJPkA8GPgXmAz8JD9rR2FXAoTRABDUfzYEsfvxTmAceCngUuBi40IJs3CxTMJzMGqj6rwFz3eS+UAGhUexf3Ad4AbgG8D9wGPoOlUEcAIWv74c35qsAjc2Z8Ffgv4GWB95P4zRwJYbiFTTABF4rNhrN+w8fPYAlwHXAlca3kWJVxFAMsCjcCqbQTeDrweOCZSgJU0B14swvPEZNswpb8a+KS97utBxlR4WqPsRYkAVjiawAuA9wHPqSGAYgV6BotFLvuBrwAfBu6IvIiqsZxLBadQYcWEhaMDXAO8AfinHqFFVmENV3s4tg54FXAF8AuUsyfNCuXONIYigFEaywL4AfC7wBcp1xoUslJ9hwYt4Gzgzy2kahm5tqLPFYmcg8ZVBDD0+DgD7rJQ4EpmryeIK+WU9e72inxB1QnAfwTejEuu5nQnEAURwMgRgBfkFvBD4P3A9YEVq4tdZf27SfEgcCzwLgsLUlO2mcZRBDCKwpyb0n8L+CCu6CUVx8ptrca4kcAxwOW46da2vAARwHKwZD7ub+Lmuf+M7jr/rML9FWaTwAyu+vIduDLsTiC3IlARwMiiY4o9BXwBN79NhRs76m75oOL/KhnNgQuNBCZQybAIYBmRALiFRX+Bq40Pw4CqjPawlD1eyNRPgnKx7j+rOHzl5Vrg1cArJVYigOUUEvj1BTeaJzBToVjDmA2oU9wiQVSpzwzCg/ByuhFXdn2SREsEsFzg6+D3AR8H/rVC4Qet/J3E0Y6OTvRzh+4lwlWEsNjPFS7SOgf4dcsPSIZFAMsCPsb9oXkBuyo8gEHmA5q4mYrwGIuOVvRzk7I6Lw8IgUVW+LoxnAB+BXhq5GUJ84A6Ag3O1favVwAvAZ6bEO5BoQ3cA3yPsvCmjZt2mwksv+9oNA4cAhyJa46yydzx8HzZEhuUsGvTycBluB4De6PrKjkoAhhpT+BB4F+ApwCHmrINam7bX2sH8Ne4NQt58N60KXOYCPS9ESftfg83AjjF3PELcQU7PtwZFJldAnzaSCCLvAGRgAhgZD2BBq5E+FLgggELq7/WAeB28wIWgpOAi8waX0w5RbdUJc4huZxmBHTPgIlHOQBhwUJ8J3CrudvNIVislrnzzUQuoBnE+s3oCHMCTVx3n78F3oZLcO6gu0hnqfIaGa5f4/PMKykkyyKA5aL8PoF2Pa4/XsbguuCEyuiTeD7ej2cEctKzBDNBmNAwUrgH+H3gL3ENQZfaDfchynnA0dGzyf0XAYys8nvFK3DrBO6M/jbMe5vLvH3Y698nANu4xU++1qGxRM8Vnu90yg5Mgghg5ON/L7xNXDLwjuD3YVcCLvT7HVzZ8xWUtQ7tJbTKBa6ByMboWoIIYKS9gCJQ+O8Djw2BABZzyi7uBPwtXFMUL1+LPU8felLrLJeRoXoAEcAy8QLC17vt8AI9jJBkMeG3UvsubsOQ1hISm1f4DZQ7DgkigGUBn/T7cWAtB6382SIqYvzzI7gW34MgsAnUI0AEsAzRxK0OvDtyl1fC/95XFA6CwJpy/UUAy3XsC8sB7B/C/6KxhMrZGIBV9ko/hTYTEQEs01wA5irvGLAVW+wCnSIitUNxCbpBYDejt6uyCEDo24LttoMVEAL4+z+FskJvKYltxsauGML4iQCEeSt9KKxT1G+FNQgPoJF4r85LyCo+N4Or0X8uZT+/pfA0/D1sw207DkoEzgtaDDQ8199jGFWABd2FM6Gl7rWnYS+F/g3g3CVQyiK61wz4EW6rcX9f8gBEAMuSFIaRxGpQNvfwRJRS8H68AE8mbzYCWE93996lwq24foty/0UAyy4UiHfCGSRyXCONcNvuFt0VdVUtyxrBPXviOgN4I/BaXGVeuDovW4KxK3CFRjfguisxhDEUAQiL5tIOSni9Mm4AXobLnj+Mq0XYPcdzrce15boYeDHwTNwS3TikWGzF97gJ19PA7yeoqUARwLLEID0Ab5XXAS/HNSTZietVeK+RQNj4Mwusue8H0DACOQW3YceZuHZh/lkazE52LnYicBr4B1zFof+bQgARwLILAxhS/JqZBT/Tfn82LmN/gHJDk7i9VtgkZDK6/3aQU1hqjykDrgW+RrkUWdZfBCDM0/MIe/9tmMN3vafQTMhRRu/ZhLkqv7/Wo7it1h5GuyuLAJZx/D9sofUWO5WL6HVvYbPQ+U4XztXyN3GJv78BrmHuTUwEEcDIkcBiK8tCQpFsRO/RX3cf8FngQ2hvQBGAMPA8xSAJ0V/bJxV34voN/glu+hK5/iIAYeWRTRiOtHGNPh4EPgh8zryARiK/ICIQAQgrJCzyeYgx4Bu4RqM34HoMeK+grlpRZCACEJYh2pR1Bo8Dfw98ElfsAy4JqA1ARADCCrT6mcniFG6O//PA13FTfl75O0PIS4gABGGJld9b/1txuwt9DdclCdyS4njloiACEFYQATTMuj+E22HoSFwzkS24Vmke8UYj8gREAMIyRyOw9JcCP4Vb3vtD4EbgFuA+XOOPcLly0cOjEEQAwjJChmvvfYwd5wCvwk0BfhWXEPw2bhqwSOQPij7IQahhYEEYpbDAN0k5DvhN3Mq/P8b1HcgqrL5CAhGAsAIUP5RNL59HA28FvgL8cuQ5SPlFAMIKUP5QqbOIFHzTj7OAjwB/iFuSLOUXAQgrJAcQdyGOf/czAE8A3gG8B9fYJMwDKP4XAQgrMBwIZTUHDsc1IH0XbsrQ9woQRADCHJDP4ygGaG2LCk+hg2tD9jbLCayluxGpIAJYtjHwoP//cz1Cdz3sDLSUzxCv+mvgWpgdClyOa0yaS57nDtUBjEb8OyzBnaLcVy+jO/NeBFY1fK9VY0ByFmffwbAnYZ3sTuN2InoTcCduu/Vw3YAgAhhpxccEdmwI198M/HfgJ5QtviZwVXmZWdiO/W3MjjXmem+w10MtHl+PS8g1lmB8eslvG/gZ4DJc34C4SaiKg0QAQmChG6Y0Xzf3ea4LbcZwU3DjRgLH4/YEuAS3J+AhgQex1HsD+DBkHHgprlfgzZRLh6X4ygEICRw0yz+fVXYzuOac23ELeG4EPoYr3X0L8N0B5zZadp1n4tYTpK7da7NTEYCwKhAuvw1X2jVJJ/nC2D/1fli2+zhuHf8rgE9ZfmEQux75vQlbwEXAU+hOCBaMTgNWEYAwMqHAvuj3gtlTfF6B42nAWIYaQd7gHuCPgCsHJF8+fwFwuuUDiigEkdKLAIRI4af7cNX7UZwiIIaG5QgeBf4Wt303LF5Wvqi4Py/HhwHnR9Y/63EOEYCwKkOBokIx4lr8Xt8vImLpmDt+I3AV3V18F9vyhz/7asDTgE19PrMIQEMgLLKL7GP+PbiGHjtNMZda+fz5NwFnVxCUIAIQKDf5rCOBfqbx6kKHDFeYczuDnYtfD5yqf7EIYDlZ32wI12zVuMcLtZ4+J7AVlxRcbEuc1fxtAjgqknF5ASKAkSaAQf8fFjMezmoUc8pCgUGS5RiusWgvL0VAlYCjQsLDIIDOHFz6+eYQhpF4G8OVKPcKbwR5AAO39Ck0Gfxa9ioC6Od+60gjVqxJi8mXq3cjAhCWHH4RzqCVZCkq9OIqwqOAk+dIKIuBjiy+CGC5YC1uJd0glaSXB7DQ+/DTfifgSnMHTQBSeBHAsgkHDreYtRiwgnQWSelTO/X6FXpPxXX07QyQADp0r3MQRAAjjQ0WJ+cDvu5SEU4LtybgDODFDH49/jRuJyFBBDDSlt93zzkicJkHGQLki3iuUJ5mcI1DXgk8m8E17PT3MQU8LFETAYwawuy071pzBGXV2qBDgH56AWRzDBF8WPGLwKstDMiXgNjqMv37gfvnce+rEqoDGKz1j7exOs2OQQtpqqAm9EDi+8yiZ4g/51+bwM/i2nWfQrkwaKnHM8QOIwBtICoPYOQ8AAJF8QTwpCH8L+JS4KzCS0kRU7wJh7/vMeA1wF8A5waWv1jkMUyVKYekdG/CAxDkAYwkGTwJt9NNPgSBDWPz1M46sceSJRTRNwk5F7d338txsxqD9mhyk+XtuF2EZ+i9pFkQAQwtFGgDGyl3u51msMVAHWAvC2vUcTRuG++XAi80b2Y8UMhsCccvJlK/+GgLcF3N50UIIoCRyQU8GdfCapDW0l/nUFyW/jDgAC5xtgfXLLRDd3//SVyh0no7jsAV+JxqrydRbtSZL3E4k9XIcQF8C7jNrj8Mr0oEIPQlxDmugeXplDvfDgJeMdcBLwMuNKWfotwkJA8sZdPubY0dE7i233F9f5uyL+AwvKkW8K/AP9pzNHvkYAQRwFDj/03A802ROgxnY8sJ4JgFPEMnIIlm4v1sicau6rzXATeYTGtnIBHASFv/F+D2uh/myrUisvZV1jI1FZhVyM4gNwz1tRQtXNb/qxbGjMnaiwCGodihhSpqPjOJS5xtWuJ4uZ97bi7ROCyVlU+hA3zBPAC/65Hc/jnGhMLChbaX4PrPXAT8VOCqZmgNe9VYFT0+0wRuAv4B2MVgmo/KAxD6soTxHHpucfdrA+uvctV6a51VvO/JYSvwp7jtyGLrL8gDGEoYQKT4WWCtLgVeYnFquH2VpqvS49cLHwGu1hiKAEbJ4qf+7ptjXI6be/djrw0r55ZLyAPi/ARu96EDlPP+gghgaO5rVjO+a4A3AM+qcWeFeuX3+ZIm8Dng/bh1/yJQ5QBGmlwbuMYYr+9BuIWEOVm265cuj9vPnwHeB2ym7Pkv6y8CGElBbgPn4ZbHHhW4r6nkn7yA2crvi6TGcVuMfR74IPBgoPwaNxHAyFl+L7xnAO8EnoMrsx2fh+u7nBV4vs+VR/J5J/DfgL/Crfhr0l3tJxIVAQzUshc9hLfANcT4Q+Ay3PLU8T6UZbGIoJjDsyz0fFVFUFXPVEcM/hw+VNqDK+/9GK7SL08ovxRfBLDkSt/PXnnhe6dbnPpKs/xjc1CqoiYeXiyCyBYwBvP5fpjfqOo9EIdODwGfxmX7H6Ms8VWdvwhg5DyBUEHOAz6Aa43VNouVzdGaLkRpi0X87ly/V0US/Z4nNxf/fwIfB26lXNY7I7ETAQwzlq1zVXPc/P7rgLdQ7obTqrCA87n2fOPcbIHP3qut11w9gyIIk8L1CNuB/4FL9P1vYJ9cfBHAqFh7L9iNyE3NcWvrL8WV+F5A2RJrvkrfS3mzRVTGunMXPQiwH8IoIqX3MueV/gCuhde1wDeAHxgRFDX3I4gABo48egW3BfWLTPkvAE4MiGGhLvty8YaKGsJs0l33ECr9d3CLeG7FNfJ4ELeYh4BoRQIigJHxANbgmnc8ATgeeBpu04tnAMdqTJNomxv/OPAormrvbuD7wB3AXfYekXeVB0SrKj8RwNCUvsCt3X+RKfwxwHFm6U8yQtiP24XGJ6o6UV4gXCYcZr9TB4Hw55QddwjyDRn9lW/HWfYi8mbC89Ql68J7bts9zdjh77Nth28tttus+Q5T+q24LP52XGZ/X+QVZMFYqaJPBDBSBNCwGH/ChP4B4B6zXDvtb0WgGJ3g+6ESNyLFzGt+9t9rB+drBEc/TTzyRAweu8/NCtc97vxTBEo+HRz+Hj0h+L/vjZS8Suby4Nn7CTvk/i+FoG/e/IhGQVhs8gw9Fmo8HkEewMijEVnD2FXuZ6psJaGfKcF+9x4URADLQuDzijhZlkxY9tZNmL/FEwQRgOJdQRAByCMQBOUAVoXVFxkI8gAEQZAHsBrJsNfKvH6KV+Kim7lUwsUtx+cawhTzeNZsnt/Nelw7LkCaa61AfI35TsmuyvoEEUCJfIlIJV9ERfRHZ4HCWtfgo6gguSKhqFXnKubwjP2OQ9V1VVgkAlgwmri6/xZlAUsjoXxFH/F/Tlkam9coXxPX5cavmvP19HmfJDVp38/moDgzuHr9osZaphRtouJ5shrvp2HfawXf8+OSRYSy1p7Hry3YT3chUcrj8j+P2XcbPTyVuCQ7fo59rMLiJRFAqUyX4Fb4jZkgTAbj4xXVK2FOurw1N+G9G7fc9UcVAl8Az8R1DdpoCvAwruX15h5hxSRuf4HnAE8yJYsJwgu7J5oCtwz3Ybuvm3E1+728nkPsOk/BLdm9FrcOooo4isDrORZ4GXAmZTef7+H28TtgYzpj778eONvGfQvwKbq7AVXJ7pNw+yyeDRxKWbXp12fkiWcsIg/Fk9QncBuMLiSMEAEsQ2SmtPcBv4LbuivcgaZR4x6nrLMnh53AFcBHTajj5iCXAW8LlPRR3FLZLcxeBejPeR7wO8DFuA5EjYTLnSXc9fB59uO20/oocGPiWRqmPCcCf4zbyXidEdmXgXcbGXiiLBKWPweeaM94IWVrtO8C1xjJNY0AngW82b7nz/kd4HbzVlIkczLwW8Av2nUazG4T3m8fQ09a99n97QrGQASwCuCF5PvAbwO32euGeYQRITbh2oMdAfyuEULYJWgD3c1Cm7guuFVNN34B+M/Ak4NrFQnlDYXdL09uBQSwwRTnTFzX4isTZLHWlPdVwT2OA7+M643w74F7g9CgKizynpO/371GQOFn15tX48emZUo4k1D8AteD4U/NW5usIOeYAOPnIyKMhnkQE6tN+DUNWOKgWYEPA68wC3mLKeWBOSYJfSy7xhTpjcze+ccvJZ621z24NfQxqeS4LcXfba5uM1COcOVdaq/BsCFpI7huE3iqKdK/CZSmZa/HAS8wBe4E+YMx4JeA/wScZmM2RnV2PwyVZsxzmE6MVRFcZxeuh0An4bafaf+Xnw5yBjORt9QI8irhuIQy30h4WPfZ/4DVlFSUB9CtSE2zUlebO3iSHeNmHcaYPS1GIHCT5jI/L1DUQ8zifhbXGCOlnP5cBxPKfzzwa5YzaNtnx3DNNa7D9SiYis7h+xV669sCjjbFeVpwnlONWO60fIXHYfb5MHHWsnO3jCAbwXfjcCBUtiwKLWKL3aR7hsM3FQnHoY1rwfYGi/m9d+P3CLjFPLftAaGGzVjiZioH7fB5m52W3zggAlidyk8gVH4Dj6123DrH891klvUCyuYeG0ypHqO6RqAdKUjDCOQi3N6CYRfdOy0c+Iads13jhnslWmvx+DvNuvvrPc3Of19gnVtGZlnkuUwEntBl9vpHuPZe8YYdeZSULIwMsx5eaCciQv/+k+2aoQu/E7dD8JdtTHYHY1EkCD4c637CQhHAKsoD+H/69ALPdaPlEy4ILPBuym63WQUBFZEy5Pb/Oc/yCe0gPv5z3FZZMYFlicSgV5g9wFUW6z7NXv375wNfBB4JlCvezOSbFqJcZHmNDm7jkw5u78MtkcXPA0Lwzz3Zg4Bj4siCn0/DzSx0gnv7Cm6X4Mdqzle3T0IWeVurbtMREUApnGOmbMcHruA03W2+GpFwxm2zZkw5zgrGdy9ue6ttEQGMRQLaSngjT7AQJCSou8ziNSOlIZHoCklgwu7xu7hW3C8MEoMb6d66LO4ZWNg1/9Hc8Lfj2p93gNfg5tD/wEiukSCALEjwZT0IoEN3LYZX+E3RZw8aAWyz9/tpL1aFhRZWiQCWeQhQmID9gcXwexOfaSasaiMgBU8WvqjFK/tNwN8kBKyTcNPj/8dRRijh9R/EzcV3mN2lKI+eqUiEGHssbxC61+OR9xFPf3oF3m4Wdwp4h+UJciOFvfbetoRr78diIiC+LEhKhsrbSeQKxnFTkSEx7TRvKEwgLkSJqyogRQCrBE1zi3MTuLFI4Qtm1wbE8XEWKKL/+2OWsMsqCCBMkk0m3Pc8+s50n8JcJcAzgYfjsZ/eVX4+JNmPy8Tvx+1/eJhd63Ibtw9YOEA0Tg3crEgzkfsogr93EvcS5gVCopii/5ZsdZueZMxvrYMIYAXBV/6Frq/fnfYnJoB+r3pfejpNOT22wdzi08xyt+2zvmrv6kgIW5EQeg8gLKh52K5NcL5JyhmGrEagqxRgTRD/e2yJSCHV028vZeZ8GrdxZwc3JXiYfebf4eb134ErbNqfiLlTxFK3qKppir41OteEPUtIuHUlzlXrFWAVryUQAaQF0QvZ/wXeZEm8IuEm58HfvXt6vrnC59jnTsSVGV9dMfahBzBO95z8LlxF3KWB6+yTYfdHHkfsdqf+1x1T1qcGz9zAtTrfS/eqxDzhOeQBWe3DTW1OmdU/0v7+avvcp4JQowhIrB+ZDD0Hf98PWejjyWu95WsaUb6AiuQoPZKDq3JR0WovBMoqBMUr1QMWc/t48/Hg2E65P8AO+30rbmfb6wNlmgBOSSTAUla7lSCk63B75vnKtVNwFXlFEC/XbQTif54yL+XXjAC8Qj+Om0c/MAeD4N3u/cDfAb8feCpjuArCD1PO2YdFSNOJWDu+31bivTtsLPzCqTEj5xdT7suQVxydxBF/RknAVYgwhg+z1n4Ofsbc+lTyL8R0kKg7FjghiuH3JoQsS3gAjSjG9fXzX8RVwa01QnmThQJX4kpypyir4kKPxK9yXAOcjpu2u4xy1eMY8M+mXEUPgxCPlb/ng0YCbeA9RlCTFvaExThTRqgHK0iqY/fViuTSlzNvxi3YucDGuG3h1Z/Y63UWykxF588TJNMIPBlfFLWNhU8BiwCWsScwQ/dOP37F3oeoLnX1ghYq3ikmpNPm0rfNwsYr23Jmb4m1LnFvB0zBTgZ+04T2GNxU3IUWCuwP7j8L3GifWFyHm048l7LefRw3Q/FnpFf4+XGoyieEJDCNq0uYAn7Pxo1gXFp2vVvprvEneH5//XG6a/I9gbRNyd9n1zjZ3nuKhVk/bwnXmUTiNt6S3N/3WEA8VwFfMo+uro+DCGAF5wDGA+GexC08ecYCzrkXt+f9v5CugAuPwyx5mEVeQMMs24dM0X/JBH4d8Hw75op9uMKeD+BKaGOvxmf8w4x9syZu9p7Llywcutzc/3BB1W24ysV2YtwngvE5lNkFQ3ngRXzKxvV3cAVN4CoMn7XA//8286iqcgYigBUcBoDL+N+DW2Xm9wLcTblCL2xA4TPQa+zv++1zfq79oMXEN5j1voey2swL2MNm3Sft8w9YHiF1f2Nm6X/PFOl1uLXw45FFa9lnfWGM37Bz2u7tAC47/02z2HdTrhQMn3Er8H+MlNbZ8+2ILGhqd6Qx3HLfe4HX4vodHGvn+wiuXNd/14dbDwA/NEvur72PdEWft8x/ZyHB68zbOpyyxqAZhXR5MPbxRqx+v8N7cEVOOyLvZuW7vtob8P8rT24u9Vtwq+FuM8HYZgrgV5lN4Cr0TsAVwnRMOe8zBdtrwuk3ESVSfi+AT8dlzE+wz9+Kmyl4vI/7PRb4OXsNKwsPsXtab4r/sCnULsoCoDsCoomnzkLhPxO3M/IJRhpfoLpZSWxUvJV/Im7W4lFT/kYUOuR2ry/BLZjKzM3/rI15VeMRn/Efx1VvPh03I3CY5UkyI7/9gTfTCYgwJOpp3EKob9iYNUQAqzcPUJg1WWtC26s23E9J7aogFahvhFmQnp+O5/fjJayplXcERHAE1bv0NqhveBESQdWOwlWNNxrRc+XBPY1Tv2uw/9xMZLFJEIHPcbQTyjpuntlu+svse69hhtnVlQoBVonih0K20xJMz8fVzN9FusjkcFyTjkNxK9J2V4QWRaRA55iH4UOHDSbEt+GmHGOFOgm3tuAos/DT5mLfXKFQp+I6Bt1i958KKdrm2p9nrzfZc2P5hQvsXm4O7mfMznu0PetMQEo+k940r+NHlEVA6yxv8QzLOfwk4XmNA2eYFd9gY/qoeQO7Ekr5RNyS5O/ZZ8Ls/SkWxl0VXQvz3k6378d9BO6wa6oScBVa/SywOi8xQT3O4uC3mjsfjtmMKcrbTTG/Y0oUJsRiIZ+w8OK3cVn8KXNBJ3DZ6/cCn6N75dxbgd/AFdnsolwgBPBJXBXe44Hb3cQt8nk/8Fcm1FOJ52zbff+lKfQrcLULhSn/f7HE5c109xb8OeDfUlbgFUFo1DGv49NGHiEBXIxrPHKVhTlFYO1Pwq3BuMTClYM29kda2PFeC7HGAqU9DtdlaRz4mN3vdruP59i4bLPr+cVEHeBXcd2MNgSJRV8M9Va7HgniFgGs8ASgdwHPx2WXfaXcC03J38Xs+vmWxZyHUE53wezpPv/z0cCvm0J8xpT+6WaF7zZlDe/rxbheeU8E/qslqQpTmLfhym5vwWXew3UFG+yejqC7Y1CcgxgzRWpFz9YyctgY3c808HHgqxa3vxxX8ANuCfTfm6LeTfdUmiez9XT3A2hbqPVmU8wvGnkcMO/qjZZIvNcIrR25+WvtnJdbnuI9dv1x+/443RWIm+z/eWJCDm6xHEXBKuoHKALojrWPNGF8trmC2ywUuAz4J0sSdZg9/783kQNIrfvfZ8K80VzdNYEl3W5WM/RKXmCCfY1Zubvs/evtPq7AtQj750iBfWvxg8yukY9zAbtMObZRdjXaHyQ+iWL+Oykz+VO4rr97cIuDvlyRL/AKeDCKsQsLbV5mZPhRXNGTxxbzRl6Em7G4PxifyShm/1XzjN5pY7kn8Hw89gfPNEV3J6JwaXa+mhRAPQHLKanXmJs6aUq63qzM0WZtD68IH4oKIo0TYTtwy4K3WDx8jlnpQ+33CyML7a3lvoT30QzCimZ0T97y+pWNeUAE8WKkdfasx1FOiR1m3z1YIS9r7NUvDprBzYD4+2rWJBXjfQwOMUs9bhY6xG47v/do4nvwhPUlI4+zzYN4LWUBVPisu4CvG7mHi6465vH9vF2rWE16oRDAHc+zOPQwXN39PbjuOJO4PnovxxWJfD5wD5smmBvte72yxxO4uftNlNN0fnXhCbgpvRDXmnW8xGLaG+38xxpZtS3ZdpDZ02sti7s/Yoo6YWR2jXkzHVOIu83KvtcSmdOWp8iCkCR8prB6cSwgqdTMgv+9sHFcS3cxkW9t9jUj2A/i2n7ttft/kT3rJy2xGI7vJOUMzDdxdQHfszDgfLvHdVEido2FU+sr5P4sI4DdqBBoVSUAwVWU+QKZz5ow+eTaZZYXOIFyegl7/9tmPQ/UEECYRT/NFHdrYMEexNUAXB8oRscU9XjcXgUvtQSc30VnD64i7n+ZBfbFPG1Tqh+bML8hsmY/sfNm9vOHcesKzrBcB3b+T+AqGMNwJrSYhX3/Ovt5K7O7EnkcsPE8HVeHEK63eNTyG+tM4d9NORffxG0i8tfmPflxye16d9k9/Mie+zN2vv9gxLQ1uIeO/e14G7vtQWKwbV7WTcH/dtXMBKgOwOF4s+T3U06HjQWJp/NMcO4LXGO/M42fBdjTg2gaZoFOoVzUM2kC/wPK6cZwmXETN613lsW4fi79IbqnAUMFPdTCi2Mpy3lb9lzfotyUwyviUeY+H2HP8JAp6j7SdQlhzf7Jpli321iF7cDCcGWTjfH36Z669M96CPBcI0hftHMvbhbmcWZv+nGYEcYDljeYCTyOE4zQbjcSCO//dCN7X8HZsfvZYuO/MzGeIoBVmg/JI9e26PHdgvruNL2EKrUnX5P02nyob/rRbyKrlXi2qt2AM2bvPNSIEqONKO8RE0Kqyi6uQKwbk15jF392VVX1KQRYGPIeChAKa6wY/Qhv0YMMUu93qK64q7q3vM+wB+obdNRtbBo2DmnWPGeYfGwkxrjoQZypPn11RBq/n/dJHKu2I5BmAaoTgySUsKiIdXt1uk1ZKW/hm1S3sg4tbdU9xpa/ri1Y1Z4BjR5KElr4OCwIF910ar7bId0EJIvCJOje3SdFpPEuSCkvBfrfOZno+eQBrKJEIBXCGG8J3qvjDpGApixSfL2c9Nbj8eKheK87KgS+iHIIvaxd3Ek4dOHjBqcF6XUKvUKc8Ht5zT1lzC5WqnLrix73UJBu4R5vYJrXeByrwitY7R5Aqh1VUeNq11mIXha3SLwWpBcLpaoJC6pbfxUJksl6uNNUWHMiAqsii5RnkFWMZz9udjg9WFeQU7X9WK9FVXFoUlR4ZquqN6A8gOp4NE9Y8Dqrl1UIUZ1Vib2NlPXu153tFffGbnY/nkwcsqTIqd8Yup8YP74WFYqc1eQc4u9lc/w/zOWZ5AGs4LCgSimKPpJm/QpPL6Wbq4LRh8XNe5BGPxYwRXKLpTB5xc/UeDZFTQ6FPnI2qxaqBKxXwl7Kt5DP9hLYuZBAMUeyKeY5Vgv5zELGcSH3vpTnlgcgCIIIQBAEEYAgCCIAQRBEAIIgiAAEQRABCIIgAhAEQQQgCIIIQBAEEYAgCCIAQRBEAIIgiAAEQRABCIIgAhAEQQQgCIIIQBAEEYAgCCIAQRBEAIIgiAAEQRABCIIgAhAEQQQgCIIIQBAEEYAgCCIAQRABCIIgAhAEQQQgCIIIQBAEEYAgCCIAQRBEAIIgiAAEQRABCIIgAhAEQQQgCMLyw/8DWdkFSKqvXzQAAAAASUVORK5CYII="/></svg>
<h1 id="offline-title">Bionic is offline</h1>
</div>
<p>Check your connection, then reload this page to try again.</p>
</div>
<button type="button" onclick="window.location.reload()">Reload page</button>
</main></body></html>`, {
    status: 503,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
  });
}

async function evictRequest(request) {
  await Promise.all((await caches.keys()).map(async (key) => {
    const cache = await caches.open(key);
    await cache.delete(request, { ignoreVary: true });
  }));
}

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.map((key) => caches.delete(key)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  // Vite owns development module revalidation and HMR. Passing that graph
  // through an offline worker can forward bodyless 304 responses on reload.
  // Only a stamped production build has an offline-cache contract.
  if (BUILD_ID.startsWith("__")) return;
  const { request } = event;
  const url = new URL(request.url);
  // Only immutable Vite build assets have a public offline-cache contract.
  // Never infer that application/extension responses are public from absent
  // headers, or from an in-memory classification lost when this worker restarts.
  const publicAsset = url.origin === self.location.origin && !url.search &&
    /^\/assets\/[^/]+-[a-zA-Z0-9_-]{8,}\.[a-zA-Z0-9.]+$/.test(url.pathname);

  // Explicitly private requests must bypass BOTH cache writes and offline
  // fallback, including extension endpoints outside the host /api namespace.
  if (request.method !== "GET" || url.pathname.startsWith("/api")) {
    return;
  }
  if (request.cache === "no-store") {
    privateRequests.add(request.url);
    event.waitUntil(evictRequest(request).catch(() => {}));
    return;
  }

  // Vite development modules use the browser's conditional-response cache.
  // Passing their requests through fetch/respondWith can return a bodyless 304
  // to the module loader on reload and leave the app root empty. They are not
  // build assets and have no offline contract, so leave them to the browser.
  if (url.origin === self.location.origin &&
      /^\/(?:@fs|@vite|@id|src|node_modules)\//.test(url.pathname)) {
    return;
  }

  // Network-first; only public build assets can use an offline fallback.
  event.respondWith(
    fetch(request)
      .then(async (response) => {
        const cacheControl = response.headers.get("cache-control") ?? "";
        if (privateCacheControl.test(cacheControl)) {
          // Revoke earlier cacheable responses too. Keep an in-memory denylist
          // if storage is unavailable so offline fallback still fails closed.
          privateRequests.add(request.url);
          await evictRequest(request).catch(() => {});
        } else if (response.ok && publicAsset && !privateRequests.has(request.url)) {
          const clone = response.clone();
          await caches.open(CACHE_NAME).then(async (cache) => {
            await cache.put(request, clone);
            // A concurrent response may have revoked this URL during put().
            if (privateRequests.has(request.url)) await cache.delete(request, { ignoreVary: true });
          }).catch(() => {});
        }
        return response;
      })
      .catch(async () => {
        if (privateRequests.has(request.url)) return Response.error();
        if (!publicAsset) return request.mode === "navigate" ? offlineNavigationResponse() : Response.error();
        // Restrict lookup to this policy's cache; old arbitrary-response caches
        // must not become fallback candidates if activation cleanup fails.
        try {
          const cached = await (await caches.open(CACHE_NAME)).match(request);
          if (cached && !privateCacheControl.test(cached.headers.get("cache-control") ?? "")) return cached;
        } catch { /* Unavailable cache storage is an offline miss. */ }
        return Response.error();
      })
  );
});
